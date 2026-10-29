import { tJs } from "../shared/i18n.js";

/**
 * The Briefing card and the session summary in the Perch chat (R1.2 PR 4).
 *
 * Spliced INSIDE perchHubJs()'s IIFE (client.js), so it shares that scope's
 * API / el / line / csrf / live / current. Same pattern as card-chip.js.
 *
 *  - The Briefing card: a collapsed <details> at the top of the transcript
 *    holding exactly the block the session was started with (the server's
 *    GET /interactive/:sid/briefing `briefing`, which is the engine's own copy
 *    of briefing.js briefingText). Set through textContent only.
 *  - The summary: the Session tab's #perch-summary shows the thread's summary
 *    (with the outside-content note) and Forget, which POSTs
 *    /interactive/:sid/forget-summary after a confirm.
 *
 * Emitted inside a template literal: no backtick and no dollar-brace in the
 * client code; only the tJs interpolations below.
 */
export function perchBriefingJs(lang = "en") {
  return `
  /* ---- the Briefing card and the session summary (R1.2 PR 4) ---------------- */
  var BR_TITLE='${tJs("perch.briefingCard", lang)}';
  var BR_FORGET_CONFIRM='${tJs("perch.summaryForgetConfirm", lang)}';
  var BR_FORGOTTEN='${tJs("perch.summaryForgotten", lang)}';
  var BR_FORGET_FAILED='${tJs("perch.summaryForgetFailed", lang)}';
  var brCard=null;
  var brGen=0;

  function resetBriefing(){
    brGen++;
    if(brCard&&brCard.parentNode) brCard.parentNode.removeChild(brCard);
    brCard=null;
    drawSummary(null,null);
    var st=el('perch-summary-status'); if(st) st.textContent='';
  }

  function drawBriefing(text){
    var tr=el('perch-transcript'); if(!tr) return;
    if(brCard&&brCard.parentNode) brCard.parentNode.removeChild(brCard);
    brCard=null;
    if(typeof text!=='string'||!text) return;
    var d=document.createElement('details'); d.className='perch-briefing';
    var s=document.createElement('summary'); s.className='briefing-title'; s.textContent=BR_TITLE;
    var body=document.createElement('div'); body.className='briefing-body'; body.textContent=text;
    d.appendChild(s); d.appendChild(body);
    tr.insertBefore(d,tr.firstChild);
    brCard=d;
  }

  function drawSummary(sum,sid){
    var box=el('perch-summary'); if(!box) return;
    var txt=el('perch-summary-text'), note=el('perch-summary-note'), btn=el('perch-summary-forget');
    if(!sum||typeof sum.summary!=='string'||!sum.summary){
      box.hidden=true; if(txt) txt.textContent=''; if(note) note.hidden=true;
      if(btn) btn.onclick=null;
      return;
    }
    box.hidden=false;
    if(txt) txt.textContent=sum.summary;
    if(note) note.hidden=!sum.outsideContent;
    if(btn){ btn.disabled=false; btn.onclick=function(){ forgetSummary(sid,btn); }; }
  }

  function forgetSummary(sid,btn){
    if(!sid||btn.disabled) return;
    if(!confirm(BR_FORGET_CONFIRM)) return;
    btn.disabled=true;
    var gen=brGen, st=el('perch-summary-status');
    perchApi('POST','/interactive/'+encodeURIComponent(sid)+'/forget-summary',{}).then(function(r){
      if(!live()||current.sid!==sid||gen!==brGen) return;
      if(r.ok||r.status===404){ drawSummary(null,null); if(st) st.textContent=BR_FORGOTTEN; return; }
      btn.disabled=false; if(st) st.textContent=BR_FORGET_FAILED;
    });
  }

  function loadBriefing(sid){
    if(!sid) return;
    var gen=brGen;
    perchApi('GET','/interactive/'+encodeURIComponent(sid)+'/briefing').then(function(r){
      if(!live()||current.sid!==sid||gen!==brGen) return;
      if(!r.ok||!r.j) return;
      drawBriefing(r.j.briefing);
      drawSummary(r.j.summary,sid);
    });
  }
`;
}
