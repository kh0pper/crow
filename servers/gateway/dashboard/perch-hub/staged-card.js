import { tJs } from "../shared/i18n.js";

/**
 * The staged send card in a Perch chat (spec §12.1–§12.3; plan Task 4).
 *
 * Spliced INSIDE perchHubJs()'s IIFE (client.js), the secret-card.js pattern, so it shares that
 * scope's el / line / clearEl / perchApi / live / current. The host hooks that cannot live in the
 * module (the composer, the refetch) arrive through `stagedHost`, which client.js assigns once,
 * before its bootstrap line.
 *
 * Rules:
 *  - Emitted inside a template literal: no backtick and no dollar-brace in the client code; only
 *    the tJs interpolations below.
 *  - The card is built from the fetched row ONLY (GET /interactive/:sid/staged), never from a
 *    frame payload: every address, the subject and the body reach the page through textContent on
 *    a createElement node, so a body that looks like markup is text.
 *  - Send posts `content_hash`, the hash of the snapshot the operator is looking at. The server
 *    claims the row, re-reads the provider and refuses if Gmail's draft differs, so nothing this
 *    client can do sends a draft the operator did not see.
 *  - A row with no credential (`sendable:false`) shows no Send and no Edit: Crow cannot name the
 *    account, so the operator sends from Gmail. The provider draft id must match a fixed pattern
 *    BEFORE a link is built; a row whose id does not is shown with a line, never a link.
 *  - The draft call has already returned when the recorder writes its row (up to 5 s after the
 *    end frame), so ONE extra read is scheduled 6 s after a draft tool's end frame when the first
 *    refetch found no new row. It never reschedules itself.
 */
export function perchStagedCardJs(lang = "en") {
  return `
  /* ---- the staged send card (spec 12) ------------------------------------ */
  var STAGED_LANG='${String(lang).replace(/[^a-z-]/g, "")}';
  var STAGED_TITLE='${tJs("perch.stagedTitle", lang)}';
  var STAGED_L_TO='${tJs("perch.stagedTo", lang)}';
  var STAGED_L_CC='${tJs("perch.stagedCc", lang)}';
  var STAGED_L_BCC='${tJs("perch.stagedBcc", lang)}';
  var STAGED_NEW='${tJs("perch.stagedNew", lang)}';
  var STAGED_NORCPT='${tJs("perch.stagedNoRecipients", lang)}';
  var STAGED_L_SUBJECT='${tJs("perch.stagedSubject", lang)}';
  var STAGED_NOSUBJ='${tJs("perch.stagedNoSubject", lang)}';
  var STAGED_L_BODY='${tJs("perch.stagedBody", lang)}';
  var STAGED_YES='${tJs("perch.stagedYes", lang)}';
  var STAGED_TAINTED='${tJs("perch.stagedTainted", lang)}';
  var STAGED_SEND='${tJs("perch.stagedSend", lang)}';
  var STAGED_SENDING='${tJs("perch.stagedSending", lang)}';
  var STAGED_EDIT='${tJs("perch.stagedEdit", lang)}';
  var STAGED_SAVE='${tJs("perch.stagedSave", lang)}';
  var STAGED_CANCEL='${tJs("perch.stagedCancel", lang)}';
  var STAGED_ASK='${tJs("perch.stagedAsk", lang)}';
  var STAGED_ASK_SEND='${tJs("perch.stagedAskSend", lang)}';
  var STAGED_ASK_PH='${tJs("perch.stagedAskPlaceholder", lang)}';
  var STAGED_ASK_PREFIX='${tJs("perch.stagedAskPrefix", lang)}';
  var STAGED_ASK_ADDED='${tJs("perch.stagedAskAdded", lang)}';
  var STAGED_NOTNOW='${tJs("perch.stagedNotNow", lang)}';
  var STAGED_FILL='${tJs("perch.stagedFillFirst", lang)}';
  var STAGED_GMAIL_LABEL='${tJs("perch.stagedOpenGmail", lang)}';
  var STAGED_NO_GMAIL='${tJs("perch.stagedNoGmailLink", lang)}';
  var STAGED_SENT='${tJs("perch.stagedSent", lang)}';
  var STAGED_REPLACED='${tJs("perch.stagedReplaced", lang)}';
  var STAGED_CHANGED='${tJs("perch.stagedChanged", lang)}';
  var STAGED_ALREADY='${tJs("perch.stagedAlreadySent", lang)}';
  var STAGED_DISCARDED='${tJs("perch.stagedDiscarded", lang)}';
  var STAGED_NOTOWNER='${tJs("perch.stagedNotOwner", lang)}';
  var STAGED_BADADDR='${tJs("perch.stagedBadAddress", lang)}';
  var STAGED_NOTEDIT='${tJs("perch.stagedNotEditable", lang)}';
  var STAGED_GENERIC='${tJs("perch.stagedFailedGeneric", lang)}';
  var STAGED_OFFLINE='${tJs("perch.stagedOffline", lang)}';
  var STAGED_RETRY='${tJs("perch.stagedRetry", lang)}';
  var STAGED_NL=String.fromCharCode(10);

  /* A Gmail draft id, and nothing else, may reach a URL. */
  var STAGED_DRAFT_ID=/^[A-Za-z0-9_-]{1,200}$/;
  var STAGED_GMAIL='https://mail.google.com/mail/#drafts?compose=';
  var STAGED_DELAY_MS=6000;

  /* The host: { api(method,path,body) -> Promise<{ok,status,j}>, askChange(text) -> bool,
     reload() -> void }. client.js assigns it; a card rendered without one simply has no actions
     that need it. */
  var stagedHost=null;
  /* Per transcript: the node drawn for a row, the row's display key, the provider draft it was
     drawn from (the replacement test), its quiet note, and the ids that reached a final state here
     (sent / already sent / a discarded edit) and must not be redrawn or dropped by a later refetch. */
  var stagedNodes={};
  var stagedKeys={};
  var stagedDrafts={};
  var stagedNotes={};
  var stagedFinal={};
  var stagedDelayedSid=null;

  function stagedFill(s,vals){
    var out=String(s);
    var keys=Object.keys(vals||{});
    for(var i=0;i<keys.length;i++) out=out.split('{'+keys[i]+'}').join(String(vals[keys[i]]));
    return out;
  }
  function stagedButton(parent,cls,text,fn){
    var b=document.createElement('button');
    b.type='button'; b.className=cls; b.textContent=text; b.onclick=fn;
    parent.appendChild(b);
    return b;
  }
  function stagedBusy(actions,on){
    var kids=(actions&&actions.children)||[];
    for(var i=0;i<kids.length;i++){ if(kids[i]&&kids[i].tagName==='BUTTON') kids[i].disabled=on; }
  }
  function stagedRemove(node){ if(node&&node.parentNode) node.parentNode.removeChild(node); }
  function stagedFind(node,cls){
    if(!node) return null;
    if(String(node.className||'').split(' ').indexOf(cls)>=0) return node;
    var kids=node.children||[];
    for(var i=0;i<kids.length;i++){ var hit=stagedFind(kids[i],cls); if(hit) return hit; }
    return null;
  }
  function stagedNow(){
    try{ return new Date().toLocaleTimeString(STAGED_LANG,{hour:'2-digit',minute:'2-digit'}); }
    catch(e){ return new Date().toLocaleTimeString(); }
  }
  function stagedSplit(v){
    var parts=String(v==null?'':v).split(','), out=[];
    for(var i=0;i<parts.length;i++){ var p=parts[i].trim(); if(p) out.push(p); }
    return out;
  }
  function stagedJoin(list){
    return (Array.isArray(list)?list:[]).join(', ');
  }
  /* [address] with the kind's label, in to/cc/bcc order — every one of them, bcc included. */
  function stagedRecipients(snap){
    var out=[], lists=[['to',STAGED_L_TO],['cc',STAGED_L_CC],['bcc',STAGED_L_BCC]];
    for(var i=0;i<lists.length;i++){
      var arr=(snap&&snap[lists[i][0]])||[];
      if(!Array.isArray(arr)) continue;
      for(var j=0;j<arr.length;j++) out.push({kind:lists[i][1],addr:String(arr[j])});
    }
    return out;
  }
  function stagedNewSet(item){
    var set={}, list=(item&&item.newRecipients)||[];
    for(var i=0;i<list.length;i++) set[String(list[i]).toLowerCase()]=true;
    return set;
  }
  /* The Gmail link, or null: the id is validated here so a row can never put anything but a
     draft id into a URL. */
  function stagedGmailUrl(item){
    var id=item&&item.providerDraftId;
    if(typeof id!=='string'||!STAGED_DRAFT_ID.test(id)) return null;
    return STAGED_GMAIL+id;
  }
  function stagedBrackets(list){
    var out=[];
    for(var i=0;i<(list||[]).length;i++) out.push('['+String(list[i])+']');
    return out.join(', ');
  }

  /* One field's label + control, for the inline editor. */
  function stagedField(parent,text,value,multiline){
    var wrap=document.createElement('div'); wrap.className='staged-field';
    var lb=document.createElement('label'); lb.className='staged-label'; lb.textContent=text;
    var inp=multiline?document.createElement('textarea'):document.createElement('input');
    if(!multiline) inp.type='text';
    inp.value=value==null?'':String(value);
    inp.setAttribute('spellcheck','false');
    wrap.appendChild(lb); wrap.appendChild(inp); parent.appendChild(wrap);
    return inp;
  }

  /* ---- the card ---------------------------------------------------------- */
  /* Built from the row only. The third argument overrides the state drawn: {kind:'sent'|'already'|
     'not_owner'|'failed', reason} plus an optional quiet note. */
  function stagedCard(item,host,final){
    var f=final||{};
    var card=document.createElement('div'); card.className='entry staged-card';
    card.setAttribute('data-staged-id',String(item.id));
    card.setAttribute('role','group');
    card.setAttribute('aria-label',STAGED_TITLE);
    card.appendChild(line('staged-title',STAGED_TITLE));
    if(f.note) card.appendChild(line('staged-note',String(f.note)));

    var rcpts=stagedRecipients(item.snapshot||{}), fresh=stagedNewSet(item);
    if(!rcpts.length) card.appendChild(line('staged-rcpt staged-none',STAGED_NORCPT));
    for(var i=0;i<rcpts.length;i++){
      var r=rcpts[i], row=document.createElement('div'); row.className='staged-rcpt';
      row.appendChild(line('staged-label',r.kind));
      row.appendChild(line('staged-addr',r.addr));
      if(fresh[r.addr.toLowerCase()]) row.appendChild(line('staged-new',STAGED_NEW));
      card.appendChild(row);
    }
    var subject=(item.snapshot&&item.snapshot.subject)?String(item.snapshot.subject):'';
    card.appendChild(line('staged-label',STAGED_L_SUBJECT));
    card.appendChild(line('staged-subject',subject||STAGED_NOSUBJ));
    var body=(item.snapshot&&item.snapshot.body)?String(item.snapshot.body):'';
    card.appendChild(line('staged-label',STAGED_L_BODY));
    card.appendChild(line('staged-body',body));
    card.appendChild(line('staged-yes',STAGED_YES));
    if(item.tainted) card.appendChild(line('staged-taint',STAGED_TAINTED));

    var status=line('staged-status','');
    status.setAttribute('role','status');
    var actions=document.createElement('div'); actions.className='staged-actions';

    if(f.kind==='sent'){
      status.textContent=stagedFill(STAGED_SENT,{time:stagedNow(),recipients:rcpts.length?stagedJoin(rcpts.map(function(x){ return x.addr; })):STAGED_NORCPT});
      card.appendChild(status);
      return card;
    }
    if(f.kind==='already'){ status.textContent=STAGED_ALREADY; card.appendChild(status); return card; }
    if(f.kind==='not_owner'){ status.textContent=STAGED_NOTOWNER; card.appendChild(status); return card; }

    card.appendChild(status); card.appendChild(actions);
    if(String(item.state)==='sending'){ status.textContent=STAGED_SENDING; return card; }

    var placeholders=Array.isArray(item.placeholders)?item.placeholders:[];
    var blocked=placeholders.length>0;
    var fillText=stagedFill(STAGED_FILL,{list:stagedBrackets(placeholders)});
    var failed=(f.kind==='failed'||String(item.state)==='failed');
    if(failed) status.textContent=String(f.reason||item.failReason||STAGED_GENERIC);
    else if(blocked) status.textContent=fillText;
    /* A failed send whose draft still holds brackets says both: why it failed, and what blocks
       the retry. */
    if(failed&&blocked) card.appendChild(line('staged-block',fillText));

    if(item.sendable){
      var send=stagedButton(actions,'primary staged-send',String(item.state)==='failed'||f.kind==='failed'?STAGED_RETRY:STAGED_SEND,
        function(){ stagedSend(item,host,card,status,actions); });
      if(blocked) send.disabled=true;
      stagedButton(actions,'staged-edit',STAGED_EDIT,function(){ stagedEditForm(item,host,card,actions,status); });
    } else {
      var url=stagedGmailUrl(item);
      if(url){
        var a=document.createElement('a'); a.className='staged-gmail'; a.href=url;
        a.textContent=STAGED_GMAIL_LABEL; a.setAttribute('rel','noopener'); a.setAttribute('target','_blank');
        actions.appendChild(a);
      } else {
        actions.appendChild(line('staged-gmail-none',STAGED_NO_GMAIL));
      }
    }
    if(host&&typeof host.askChange==='function'){
      stagedButton(actions,'staged-ask',STAGED_ASK,function(){ stagedAskForm(item,host,card,actions,status); });
    }
    stagedButton(actions,'staged-notnow',STAGED_NOTNOW,function(){ stagedDiscard(item,host,card,status,actions); });
    return card;
  }

  /* Swap a card for its new state in place; the row is final here, so no later refetch redraws it. */
  function stagedSwap(card,node){
    var id=card&&card.getAttribute?card.getAttribute('data-staged-id'):null;
    if(card&&card.parentNode){ card.parentNode.insertBefore(node,card); card.parentNode.removeChild(card); }
    if(id!=null){ stagedNodes[String(id)]=node; stagedKeys[String(id)]='final'; }
    return node;
  }

  /* ---- actions ----------------------------------------------------------- */
  function stagedSend(item,host,card,status,actions){
    if(!host||typeof host.api!=='function') return;
    stagedBusy(actions,true); status.textContent=STAGED_SENDING;
    host.api('POST','/staged/'+encodeURIComponent(String(item.id))+'/send',{content_hash:String(item.contentHash)}).then(function(r){
      var j=r&&r.j;
      if(r&&r.ok&&j&&j.state==='sent'){
        stagedFinal[String(item.id)]=true;
        stagedSwap(card,stagedCard(item,host,{kind:'sent'}));
        return;
      }
      if(r&&r.ok&&j&&j.state==='failed'){
        stagedSwap(card,stagedCard(item,host,{kind:'failed',reason:j.failReason}));
        return;
      }
      if(r&&r.status===409&&j&&j.error==='changed'){
        /* The provider holds something else: the server replaced the row with Gmail's own
           snapshot. Show THAT row, and say quietly why it looks new. */
        stagedReload({id:j.id==null?null:String(j.id),oldId:String(item.id),note:STAGED_CHANGED});
        return;
      }
      if(r&&r.status===409&&j&&j.error==='already_sent'){
        stagedFinal[String(item.id)]=true;
        stagedSwap(card,stagedCard(item,host,{kind:'already'}));
        stagedReload({});
        return;
      }
      if(r&&r.status===403){ stagedSwap(card,stagedCard(item,host,{kind:'not_owner'})); return; }
      if(r&&r.status===409&&j&&j.error==='placeholders'){
        status.textContent=stagedFill(STAGED_FILL,{list:stagedBrackets(item.placeholders)});
        stagedBusy(actions,false); return;
      }
      if(r&&r.status===409&&j&&j.error==='open_in_gmail'){ stagedSwap(card,stagedCard(item,host,{})); return; }
      status.textContent=(!r||r.status===0)?STAGED_OFFLINE:STAGED_GENERIC;
      stagedBusy(actions,false);
    });
  }

  function stagedDiscard(item,host,card,status,actions){
    if(!host||typeof host.api!=='function') return;
    stagedBusy(actions,true);
    host.api('POST','/staged/'+encodeURIComponent(String(item.id))+'/discard',{}).then(function(r){
      if(r&&r.ok){
        stagedFinal[String(item.id)]=true;
        var gone=document.createElement('div'); gone.className='entry staged-card staged-gone';
        gone.setAttribute('data-staged-id',String(item.id));
        gone.appendChild(line('staged-note',STAGED_DISCARDED));
        stagedSwap(card,gone);
        stagedReload({});
        return;
      }
      if(r&&r.status===409){ stagedReload({oldId:String(item.id),dropOld:true}); return; }
      if(r&&r.status===403){ stagedSwap(card,stagedCard(item,host,{kind:'not_owner'})); return; }
      status.textContent=(!r||r.status===0)?STAGED_OFFLINE:STAGED_GENERIC;
      stagedBusy(actions,false);
    });
  }

  /* Inline edit: the operator's own text, posted as arrays of single addresses. */
  function stagedEditForm(item,host,card,actions,status){
    if(stagedFind(card,'staged-form')) return;
    if(!host||typeof host.api!=='function') return;
    var snap=item.snapshot||{};
    var form=document.createElement('div'); form.className='staged-form';
    var to=stagedField(form,STAGED_L_TO,stagedJoin(snap.to),false);
    var cc=stagedField(form,STAGED_L_CC,stagedJoin(snap.cc),false);
    var bcc=stagedField(form,STAGED_L_BCC,stagedJoin(snap.bcc),false);
    var subject=stagedField(form,STAGED_L_SUBJECT,snap.subject,false);
    var body=stagedField(form,STAGED_L_BODY,snap.body,true);
    var row=document.createElement('div'); row.className='staged-actions';
    stagedButton(row,'primary staged-save',STAGED_SAVE,function(){
      stagedBusy(row,true);
      host.api('POST','/staged/'+encodeURIComponent(String(item.id))+'/edit',{
        to:stagedSplit(to.value), cc:stagedSplit(cc.value), bcc:stagedSplit(bcc.value),
        subject:String(subject.value==null?'':subject.value), body:String(body.value==null?'':body.value)
      }).then(function(r){
        var j=r&&r.j;
        if(r&&r.ok&&j&&String(j.code)==='edited'){
          stagedFinal[String(item.id)]=true;
          stagedReload({id:j.id==null?null:String(j.id),oldId:String(item.id),dropOld:true});
          return;
        }
        stagedBusy(row,false);
        if(r&&r.status===400&&j&&j.error==='bad_address'){ status.textContent=STAGED_BADADDR; return; }
        if(r&&r.status===409&&j&&j.error==='changed'){
          stagedReload({id:j.id==null?null:String(j.id),oldId:String(item.id),note:STAGED_CHANGED}); return;
        }
        if(r&&r.status===409&&(j&&(j.error==='not_editable'||j.error==='open_in_gmail'))){ status.textContent=STAGED_NOTEDIT; return; }
        if(r&&r.status===403){ status.textContent=STAGED_NOTOWNER; return; }
        status.textContent=(!r||r.status===0)?STAGED_OFFLINE:STAGED_GENERIC;
      });
    });
    stagedButton(row,'staged-cancel',STAGED_CANCEL,function(){ stagedRemove(form); });
    form.appendChild(row);
    card.insertBefore(form,actions);
  }

  /* Ask for a change: the operator's note goes into the composer behind a fixed line, so the
     ordinary send path (and its paste detector) runs. Nothing is sent from here. The note is
     APPENDED to whatever is already in the composer: unsent words of the operator's are theirs,
     and this button may not replace them. */
  function stagedAskForm(item,host,card,actions,status){
    if(stagedFind(card,'staged-askform')) return;
    if(!host||typeof host.askChange!=='function') return;
    var form=document.createElement('div'); form.className='staged-form staged-askform';
    var note=stagedField(form,STAGED_ASK,'',true);
    if(note.setAttribute) note.setAttribute('placeholder',STAGED_ASK_PH);
    note.placeholder=STAGED_ASK_PH;
    var row=document.createElement('div'); row.className='staged-actions';
    stagedButton(row,'primary staged-asksend',STAGED_ASK_SEND,function(){
      var text=String(note.value==null?'':note.value).trim();
      if(!text) return;
      if(host.askChange(STAGED_ASK_PREFIX+STAGED_NL+text)!==false){
        stagedRemove(form);
        status.textContent=STAGED_ASK_ADDED;
      }
    });
    stagedButton(row,'staged-cancel',STAGED_CANCEL,function(){ stagedRemove(form); });
    form.appendChild(row);
    card.insertBefore(form,actions);
  }

  /* ---- the list ---------------------------------------------------------- */
  function stagedKey(item){
    var id=String(item.id);
    return [String(item.state||''),String(item.contentHash||''),String(item.providerDraftId||''),
      item.sendable?'1':'0',item.tainted?'1':'0',(item.placeholders||[]).join(','),
      (item.newRecipients||[]).join(','),String(item.failReason||''),stagedNotes[id]||''].join('|');
  }
  function stagedTombstone(id){
    var node=document.createElement('div'); node.className='entry staged-card staged-replaced';
    node.setAttribute('data-staged-id',String(id));
    node.setAttribute('data-staged-replaced','1');
    node.appendChild(line('staged-note',STAGED_REPLACED));
    return node;
  }
  /* Draw (or redraw) every row the server sent; drop the ones it no longer sends. A card that
     disappears while the provider's draft is now held by a NEWER row was REPLACED by it (a bot's
     new draft, or Gmail's own text after a refused send) and says so; one that merely goes away —
     discarded in another tab, deleted in Gmail — is dropped without a word. Returns true when the
     answer held a row this transcript had never drawn — the delayed refetch's signal. */
  function stagedDraw(items){
    var tr=el('perch-transcript'); if(!tr) return false;
    var list=Array.isArray(items)?items:[], anyNew=false, seen={}, seenDrafts={}, i, it;
    for(i=0;i<list.length;i++){
      it=list[i]; if(!it||it.id==null) continue;
      seen[String(it.id)]=true;
      if(it.providerDraftId) seenDrafts[String(it.providerDraftId)]=true;
    }
    /* Oldest first, so the newest draft lands last, where the eye (and the scroll) already is. */
    for(i=list.length-1;i>=0;i--){
      var item=list[i]; if(!item||item.id==null) continue;
      var id=String(item.id);
      if(!stagedNodes[id]&&!stagedFinal[id]) anyNew=true;
      if(stagedFinal[id]) continue;
      var key=stagedKey(item);
      if(stagedNodes[id]&&stagedKeys[id]===key) continue;
      var node=stagedCard(item,stagedHost,{note:stagedNotes[id]||null});
      if(stagedNodes[id]&&stagedNodes[id].parentNode){
        stagedNodes[id].parentNode.insertBefore(node,stagedNodes[id]);
        stagedNodes[id].parentNode.removeChild(stagedNodes[id]);
      } else tr.appendChild(node);
      stagedNodes[id]=node; stagedKeys[id]=key; stagedDrafts[id]=String(item.providerDraftId||'');
    }
    for(var k in stagedNodes){
      if(seen[k]||stagedFinal[k]) continue;
      var old=stagedNodes[k];
      var wasTomb=old&&old.getAttribute&&old.getAttribute('data-staged-replaced')==='1';
      var draftId=stagedDrafts[k]||'';
      /* Replaced only when the same provider draft is now held by a newer row: a row that merely
         left the list is not "replaced by" an unrelated draft, and saying so would be a lie the
         operator cannot check. */
      if(draftId&&seenDrafts[draftId]&&!wasTomb){
        var tomb=stagedTombstone(k);
        if(old&&old.parentNode){ old.parentNode.insertBefore(tomb,old); old.parentNode.removeChild(old); }
        else tr.appendChild(tomb);
        stagedNodes[k]=tomb; stagedKeys[k]='tomb';
      } else if(!wasTomb){
        stagedRemove(old);
        delete stagedNodes[k]; delete stagedKeys[k]; delete stagedNotes[k]; delete stagedDrafts[k];
      }
    }
    return anyNew;
  }

  /* Apply a reload hint (the quiet note a replacement row carries, or the id to forget) and ask
     the host to read again. */
  function stagedReload(hint){
    var h=hint||{};
    if(h.note&&h.id!=null) stagedNotes[String(h.id)]=String(h.note);
    if(h.oldId!=null&&h.dropOld){
      var id=String(h.oldId);
      stagedRemove(stagedNodes[id]);
      stagedFinal[id]=true;
      delete stagedNodes[id]; delete stagedKeys[id]; delete stagedNotes[id]; delete stagedDrafts[id];
    }
    if(stagedHost&&typeof stagedHost.reload==='function') stagedHost.reload();
  }

  /* The delayed read: the recorder can write its row up to 5 s after the tool's end frame, so a
     refetch right after it may find nothing. ONE more read 6 s later, never a loop. */
  function stagedDelayedRefetch(sid){
    if(stagedDelayedSid===String(sid)) return;
    stagedDelayedSid=String(sid);
    setTimeout(function(){
      stagedDelayedSid=null;
      if(!live()||current.sid!==String(sid)) return;
      loadStaged(String(sid));
    },STAGED_DELAY_MS);
  }

  /* GET this chat's open drafts. opts.afterDraft marks the read that a draft tool's end frame
     caused: if it finds no new row, one delayed read follows. */
  function loadStaged(sid,opts){
    if(!sid||!stagedHost||typeof stagedHost.api!=='function') return;
    var mySid=String(sid);
    stagedHost.api('GET','/interactive/'+encodeURIComponent(mySid)+'/staged').then(function(r){
      if(!live()||current.sid!==mySid) return;
      if(!r||!r.ok||!r.j||!Array.isArray(r.j.items)) return;
      var anyNew=stagedDraw(r.j.items);
      if(opts&&opts.afterDraft&&!anyNew) stagedDelayedRefetch(mySid);
    });
  }

  /* A draft tool's end frame (pi's name for it, whatever server block it came through). */
  function stagedDraftTool(name){
    var n=String(name==null?'':name);
    return n.indexOf('gmail_create_draft')>=0||n.indexOf('gmail_create_threaded_reply')>=0;
  }

  /* A session switch: the transcript, and every reading in it, is gone. */
  function resetStaged(){
    for(var k in stagedNodes) stagedRemove(stagedNodes[k]);
    stagedNodes={}; stagedKeys={}; stagedDrafts={}; stagedNotes={}; stagedFinal={}; stagedDelayedSid=null;
  }
`;
}