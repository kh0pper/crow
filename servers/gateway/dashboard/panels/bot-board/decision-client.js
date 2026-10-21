/**
 * Bot Board — the card drawer's decision block (client JS).
 *
 * A decision card carries `data_json.decision` (see
 * servers/gateway/board/decision-service.js); GET /card/:id returns it as the
 * additive `decision` key and client.js calls renderDecision(r.j.decision)
 * right after renderResults. Answering is POST /card/:id/decision with
 * {index} (or {index:-1, other_text} for "Other…").
 *
 * Like drawer.js, this returns a bare block of statements spliced into
 * client.js's IIFE, sharing its scope: $, clearEl, api, msg, errText, cur,
 * decisionCardChanged and openCardById.
 * The emitted string sits inside a template literal: no raw backticks, and
 * every backslash is doubled. Every bot-supplied string (question,
 * context_md, labels, consequences, other_text) goes in through textContent
 * only — never innerHTML.
 */

import { tJs } from "../../shared/i18n.js";

export function decisionJs(lang) {
  return `
  // ---- Decision cards: question + options in the card drawer ----
  // A date-only expires lasts through that whole UTC day (decision-service's
  // expiryMs); a full timestamp is exact; anything unparseable never expires.
  function decisionPastExpiry(expires){
    var s=String(expires==null?'':expires), t;
    if(/^\\d{4}-\\d{2}-\\d{2}$/.test(s)) t=Date.parse(s+'T00:00:00Z')+86400000;
    else t=Date.parse(s);
    return isFinite(t)&&Date.now()>=t;
  }
  function decisionEl(tag,cls,text){
    var e=document.createElement(tag);
    if(cls) e.className=cls;
    if(text!=null) e.textContent=String(text);
    return e;
  }
  // opts: {note: message shown in the block, readOnly: options shown disabled}
  function renderDecision(d,opts){
    var wrap=$('bb-d-decision'); if(!wrap) return;
    clearEl(wrap);
    if(!d||typeof d!=='object'||!Array.isArray(d.options)) return;
    opts=opts||{};
    var cardId=cur?cur.id:null;
    var box=decisionEl('div','bb-decision');
    box.appendChild(decisionEl('div','bb-decision-head','${tJs("botboard.decision.heading", lang)}'));
    box.appendChild(decisionEl('div','bb-decision-q',d.question||''));
    if(d.context_md) box.appendChild(decisionEl('div','bb-decision-ctx',d.context_md));
    var dmsg=decisionEl('div','bb-msg');
    wrap.appendChild(box);

    if(d.chosen&&typeof d.chosen==='object'){
      var c=d.chosen;
      var line=decisionEl('div','bb-decision-chosen','${tJs("botboard.decision.chosen", lang)}'+' ');
      line.appendChild(decisionEl('strong',null,c.index===-1?'${tJs("botboard.decision.other", lang)}':(c.label||'')));
      box.appendChild(line);
      if(c.other_text) box.appendChild(decisionEl('div','bb-decision-ctx',c.other_text));
      var fid=c.created_card_id!=null?c.created_card_id:d.created_card_id;
      if(fid!=null&&isFinite(Number(fid))){
        var idNum=Number(fid);
        var a=decisionEl('a','bb-decision-follow','${tJs("botboard.decision.followUp", lang)}'+' #'+idNum);
        a.href=location.pathname+location.search+'#card='+idNum;
        // Opens the follow-up card's drawer, as clicking that card would. It
        // was just created, so it may not be on this board yet: the drawer
        // loads it by id. The href stays for open-in-new-tab.
        a.onclick=function(ev){ if(ev&&ev.preventDefault) ev.preventDefault(); openCardById(idNum); };
        box.appendChild(a);
      }
      box.appendChild(dmsg);
      if(opts.note) msg(dmsg,opts.note,'warn');
      return;
    }
    if(d.expired_at||decisionPastExpiry(d.expires)){
      box.appendChild(decisionEl('div','bb-decision-expired','${tJs("botboard.decision.expired", lang)}'));
      box.appendChild(dmsg);
      if(opts.note) msg(dmsg,opts.note,'warn');
      return;
    }

    var buttons=[];
    function setBusy(on){ buttons.forEach(function(b){ b.disabled=on||!!opts.readOnly; }); }
    function send(index,otherText){
      if(cardId==null) return;
      setBusy(true); msg(dmsg,'','');
      var body={index:index};
      if(index===-1) body.other_text=otherText;
      // A late answer for a card the drawer no longer shows is dropped.
      function stillHere(){ return cur&&cur.id===cardId; }
      api('POST','/card/'+cardId+'/decision',body).then(function(r){
        if(!stillHere()) return;
        if(r.ok&&r.j){
          d.chosen=r.j.chosen||{index:index,label:index>=0&&d.options[index]?d.options[index].label:'',other_text:otherText||null};
          if(r.j.created_card_id!=null) d.created_card_id=r.j.created_card_id;
          renderDecision(d);
          // The answer moved the card on the server (it is closed now):
          // refresh the drawer's form so Save cannot send the old status.
          decisionCardChanged(cardId);
          return;
        }
        var note=errText(r,'failed');
        if(r.status===409){
          // Answered in another tab, expired, closed, archived or locked:
          // show the server's current state. Only a lock can clear by itself,
          // so every other refusal leaves the options read-only.
          var ro=!(r.j&&r.j.code==='locked');
          decisionCardChanged(cardId,true);
          api('GET','/card/'+cardId).then(function(r2){
            if(!stillHere()) return;
            renderDecision(r2.ok&&r2.j&&r2.j.decision?r2.j.decision:d,{note:note,readOnly:ro});
          }).catch(function(){ if(stillHere()) renderDecision(d,{note:note,readOnly:ro}); });
          return;
        }
        setBusy(false); msg(dmsg,note,'err');
      }).catch(function(){ if(stillHere()){ setBusy(false); msg(dmsg,'${tJs("botboard.loadFailed", lang)}','err'); } });
    }

    var list=decisionEl('div','bb-decision-opts');
    d.options.forEach(function(o,i){
      o=o||{};
      var row=decisionEl('div','bb-decision-row');
      var b=decisionEl('button','bb-btn bb-sec bb-decision-opt'+(o.recommended?' bb-decision-opt-first':''));
      b.type='button';
      b.appendChild(decisionEl('span',null,o.label||''));
      if(o.recommended) b.appendChild(decisionEl('span','bb-decision-rec','${tJs("botboard.decision.recommended", lang)}'));
      b.onclick=function(){ send(i,null); };
      row.appendChild(b);
      if(o.consequence) row.appendChild(decisionEl('div','bb-decision-cons',o.consequence));
      list.appendChild(row);
      buttons.push(b);
    });
    var otherBtn=decisionEl('button','bb-btn bb-sec bb-decision-other','${tJs("botboard.decision.other", lang)}');
    otherBtn.type='button';
    var otherWrap=decisionEl('div','bb-decision-other-wrap');
    otherWrap.hidden=true;
    var ta=decisionEl('textarea');
    ta.setAttribute('rows','3');
    ta.setAttribute('maxlength','2000');
    var sendBtn=decisionEl('button','bb-btn bb-decision-send','${tJs("botboard.decision.send", lang)}');
    sendBtn.type='button';
    sendBtn.onclick=function(){
      var v=String(ta.value||'').trim();
      if(!v) return;
      send(-1,v);
    };
    otherBtn.onclick=function(){ otherWrap.hidden=!otherWrap.hidden; };
    otherWrap.appendChild(ta);
    otherWrap.appendChild(sendBtn);
    buttons.push(otherBtn,sendBtn);
    list.appendChild(otherBtn);
    list.appendChild(otherWrap);
    box.appendChild(list);
    box.appendChild(dmsg);
    setBusy(false);
    if(opts.note) msg(dmsg,opts.note,'warn');
  }
`;
}
