/**
 * Bot Board — the card drawer's dispatch-grant checkbox (client JS).
 *
 * GET /card/:id returns the operator's grants as the additive
 * `dispatch_grants` key (bot ids) and `human_created`; client.js calls
 * renderGrant(card, grants, humanCreated) right after renderDecision. On a
 * card the operator created, its bot may already hand it on, so a short note
 * shows instead of the checkbox. Toggling posts POST /card/:id/dispatch-grant
 * {bot_id, granted} for the card's current bot; the checkbox shows only for a
 * live top-level card with a bot assigned.
 *
 * Like decision-client.js, this returns a bare block of statements spliced
 * into client.js's IIFE, sharing its scope: $, clearEl, api, msg, errText,
 * cur. The emitted string sits inside a template literal: no raw backticks,
 * and every backslash is doubled. Data goes in through textContent only.
 */

import { tJs } from "../../shared/i18n.js";

export function grantJs(lang) {
  return `
  // ---- Dispatch grant: may the card's bot hand it to another bot? ----
  function renderGrant(card,grants,humanCreated){
    var wrap=$('bb-d-grant'); if(!wrap) return;
    clearEl(wrap);
    if(!card||!card.assigned_bot||card.parent_id!=null||card.archived_at!=null) return;
    if(humanCreated){
      var own=document.createElement('div'); own.className='bb-grant-hint';
      own.textContent='${tJs("botboard.grant.ownCard", lang)}';
      wrap.appendChild(own);
      return;
    }
    var bot=String(card.assigned_bot), cardId=card.id;
    function has(list){ return Array.isArray(list)&&list.indexOf(bot)!==-1; }
    var lab=document.createElement('label'); lab.className='bb-grant';
    var cb=document.createElement('input'); cb.type='checkbox'; cb.id='bb-d-grant-cb';
    cb.checked=has(grants);
    var txt=document.createElement('span'); txt.textContent='${tJs("botboard.grant.label", lang)}';
    lab.appendChild(cb); lab.appendChild(txt);
    var hint=document.createElement('div'); hint.className='bb-grant-hint';
    hint.textContent='${tJs("botboard.grant.hint", lang)}';
    var gmsg=document.createElement('div'); gmsg.className='bb-msg';
    wrap.appendChild(lab); wrap.appendChild(hint); wrap.appendChild(gmsg);
    // A late reply for a card the drawer no longer shows is dropped.
    function stillHere(){ return cur&&cur.id===cardId; }
    cb.onchange=function(){
      var want=!!cb.checked;
      cb.disabled=true; msg(gmsg,'','');
      api('POST','/card/'+cardId+'/dispatch-grant',{bot_id:bot,granted:want}).then(function(r){
        if(!stillHere()) return;
        cb.disabled=false;
        if(r.ok&&r.j){ cb.checked=has(r.j.dispatch_grants); return; }
        cb.checked=!want;
        msg(gmsg,errText(r,'${tJs("botboard.grant.failed", lang)}'),'err');
      }).catch(function(){
        if(!stillHere()) return;
        cb.disabled=false; cb.checked=!want;
        msg(gmsg,'${tJs("botboard.grant.failed", lang)}','err');
      });
    };
  }
`;
}
