import { tJs } from "../shared/i18n.js";
import { detectorSource } from "../../../shared/secret-detect.js";

/**
 * The paste detector and its warning in the Perch composer (credential card spec §10.3, plan
 * Task 4).
 *
 * Spliced INSIDE perchHubJs()'s IIFE (client.js), so it shares that scope's el / line / clearEl /
 * document / current / draftSave / sendNow. Kept in its own module (the secret-card.js pattern)
 * so client.js only carries the gate.
 *
 * Rules:
 *  - Emitted inside a template literal: no backtick and no dollar-brace in the client code; the
 *    detector's rules arrive as JSON (detectorSource) and are rebuilt with new RegExp, so the
 *    client can never drift from servers/shared/secret-detect.js.
 *  - The warning is a fixed-text card with three fixed choices (Remove it / Send anyway / It's
 *    not a secret). It shows on a send and on a paste; while it is open nothing is sent and
 *    draftSave() writes nothing.
 *  - "Remove it" strips the composer's text locally and sends nothing. "Send anyway" and "It's
 *    not a secret" send THIS text once: "strip" asks the server to remove what it finds, "keep"
 *    tells it not to (the answer is per send, never remembered).
 *  - The warning's help text links to the project's Services page when the session is filed in
 *    one; the slug is validated before it goes into the href.
 */
export function perchSecretWarnJs(lang = "en") {
  // JSON-safe (no backtick), and its backslash escapes arrive exactly as the client needs them
  // inside a JavaScript string literal.
  const det = JSON.stringify(detectorSource());
  return `
  /* ---- the paste detector and its warning (credential card, spec 10.3) --- */
  var SEC_DET=${det};
  var SEC_WARN_TITLE='${tJs("perch.secretWarnTitle", lang)}';
  var SEC_WARN_HELP='${tJs("perch.secretWarnHelp", lang)}';
  var SEC_WARN_SERVICES='${tJs("perch.secretWarnServices", lang)}';
  var SEC_WARN_REMOVE='${tJs("perch.secretWarnRemove", lang)}';
  var SEC_WARN_SEND='${tJs("perch.secretWarnSend", lang)}';
  var SEC_WARN_KEEP='${tJs("perch.secretWarnKeep", lang)}';
  var SEC_REMOVED_ONE='${tJs("perch.secretRemovedOne", lang)}';
  var SEC_REMOVED='${tJs("perch.secretRemoved", lang)}';

  /* A fresh copy of a rule: the JSON carries /g sources, and lastIndex must not leak. */
  function secRe(pat){
    var flags=String(pat.flags||'');
    if(flags.indexOf('g')<0) flags+='g';
    return new RegExp(pat.source,flags);
  }
  /* Shannon entropy, bits per character (secret-detect.js's shannonBits). */
  function secBits(s){
    if(!s) return 0;
    var counts={},n=0,i,ch,keys,bits=0;
    for(i=0;i<s.length;i++){ ch=s.charAt(i); counts[ch]=(counts[ch]||0)+1; n++; }
    keys=Object.keys(counts);
    for(i=0;i<keys.length;i++){ var p=counts[keys[i]]/n; bits-=p*(Math.log(p)/Math.LN2); }
    return bits;
  }
  function secLongest(seg){
    var ps=String(seg).split(/[-_]+/),m=0,i;
    for(i=0;i<ps.length;i++){ if(ps[i].length>m) m=ps[i].length; }
    return m;
  }
  function secMeanPiece(seg){
    var r=new RegExp(SEC_DET.entropy.piece.source,SEC_DET.entropy.piece.flags);
    var ps=String(seg).match(r)||[];
    if(!ps.length) return 0;
    var n=0,i;
    for(i=0;i<ps.length;i++) n+=ps[i].length;
    return n/ps.length;
  }
  /* secret-detect.js's looksRandom: a token's structure, not a name's. */
  function secLooksRandom(seg){
    var E=SEC_DET.entropy;
    if(seg.length<E.minLength) return false;
    if(!/[0-9]/.test(seg)||!/[a-z]/.test(seg)||!/[A-Z]/.test(seg)) return false;
    if(new RegExp(E.hexOnly.source,E.hexOnly.flags).test(seg)) return false;
    if(secBits(seg)<E.minBits) return false;
    if(secLongest(seg)<E.minLongestPiece) return false;
    if(secMeanPiece(seg)>=E.maxMeanPiece) return false;
    return true;
  }
  function secSkipSpans(s){
    var out=[],r=secRe(SEC_DET.entropy.skip),m;
    while((m=r.exec(s))){
      if(!m[0]){ r.lastIndex++; continue; }
      out.push([m.index,m.index+m[0].length]);
    }
    return out;
  }
  /* Every secret-looking span: [{start,end}], sorted, non-overlapping (the server's findSecrets). */
  function secFind(text){
    var s=text==null?'':String(text);
    if(!s) return [];
    var hits=[],i,m,r,end,val;
    for(i=0;i<SEC_DET.prefixes.length;i++){
      r=secRe(SEC_DET.prefixes[i]);
      while((m=r.exec(s))){
        if(!m[0]){ r.lastIndex++; continue; }
        hits.push({start:m.index,end:m.index+m[0].length});
      }
    }
    r=secRe(SEC_DET.phrase);
    while((m=r.exec(s))){
      if(!m[0]){ r.lastIndex++; continue; }
      end=m.index+m[0].length;
      val=m[SEC_DET.phrase.valueGroup];
      if(val) hits.push({start:end-val.length,end:end});
    }
    var skips=secSkipSpans(s);
    var kp=new RegExp(SEC_DET.entropy.keyedPrefix.source,SEC_DET.entropy.keyedPrefix.flags||'');
    r=secRe(SEC_DET.entropy.run);
    while((m=r.exec(s))){
      var rs=m.index,re=rs+m[0].length,skip=false;
      for(i=0;i<skips.length;i++){ if(rs<skips[i][1]&&re>skips[i][0]){ skip=true; break; } }
      if(skip) continue;
      var at=rs,segs=m[0].split(SEC_DET.entropy.segmentSeparator);
      for(i=0;i<segs.length;i++){
        /* "pass=<token>": the key and its separator are inside the run; the key's name survives.
           N3: the whole segment is tested too — a 22-character value behind "key=" is short of
           the length rule on its own, while the segment has a token's shape. */
        var seg=segs[i], val=seg, st=at, km=kp.exec(seg);
        if(km){ val=seg.slice(km[0].length); st=at+km[0].length; }
        if(secLooksRandom(val)||secLooksRandom(seg)) hits.push({start:st,end:st+val.length});
        at+=seg.length+1;
      }
    }
    hits.sort(function(a,b){ return a.start-b.start||b.end-a.end; });
    var out=[];
    for(i=0;i<hits.length;i++){
      var last=out[out.length-1];
      if(last&&hits[i].start<last.end){ if(hits[i].end>last.end) last.end=hits[i].end; continue; }
      out.push({start:hits[i].start,end:hits[i].end});
    }
    return out;
  }
  /* The composer's own copy of the server's strip: [secret removed] per span, and the count. */
  function secStrip(text){
    var s=text==null?'':String(text),hits=secFind(s),out='',at=0,i;
    for(i=0;i<hits.length;i++){ out+=s.slice(at,hits[i].start)+SEC_DET.removed; at=hits[i].end; }
    return {text:out+s.slice(at),removed:hits.length};
  }
  function secWarnFill(tpl,map){
    var out=String(tpl);
    for(var k in map) out=out.split('{'+k+'}').join(map[k]==null?'':String(map[k]));
    return out;
  }

  var secWarnPending=null;      /* the text waiting for a choice, or null (nothing on screen) */
  var secWarnAnswer=null;       /* an ask card's own choice handler, or null (the composer) */
  function secWarnOpenNow(){ return secWarnPending!=null; }
  function secretWarnNeeded(text){ return secFind(text).length>0; }
  /* The project's Services page, when this session is filed in one. The slug is operator data
     only in the sense that it comes from the DB; it is still validated before an href. */
  function secWarnHref(){
    var slug=null;
    try{
      var pr=(typeof projectOfRow==='function')?projectOfRow(rowIndex[current.sid],PROJECTS):null;
      slug=(pr&&pr.slug)?String(pr.slug):null;
    }catch(e){ slug=null; }
    if(!slug||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) return null;
    return '/dashboard/project/'+slug+'/services';
  }
  function secretWarnClose(){
    secWarnPending=null;
    secWarnAnswer=null;
    var p=el('perch-secret-warn');
    if(p){ clearEl(p); p.hidden=true; }
  }
  /* B1: the draft already stored for this session is overwritten with the stripped text the
     moment the warning opens — the composer holds the operator's words, the draft must not. */
  function secWarnDraftStrip(text){
    var sid=current.sid, store=draftStore();
    if(!sid||!store) return;
    var stripped=secStrip(String(text==null?'':text));
    try{
      if(stripped.text.trim()) store.setItem(DRAFT_PREFIX+sid,stripped.text);
      else store.removeItem(DRAFT_PREFIX+sid);
    }catch(e){}
  }
  /* onChoose is set by an ASK card (B2): it runs with "remove" (strip the field and stay),
     "strip" or "keep". Without it the warning belongs to the composer and this file sends. */
  function secretWarnDraw(text,onChoose){
    var pane=el('perch-secret-warn');
    /* No pane in this document: never swallow the operator's message over a missing element. */
    if(!pane){
      if(typeof onChoose==='function') onChoose('strip'); else sendNow(text,null);
      return;
    }
    secretWarnClose();
    secWarnPending=String(text);
    secWarnAnswer=typeof onChoose==='function'?onChoose:null;
    if(!secWarnAnswer) secWarnDraftStrip(text);
    var box=document.createElement('div'); box.className='ask-card secret-warn';
    box.setAttribute('role','group');
    box.appendChild(line('ask-title secret-warn-title',SEC_WARN_TITLE));
    box.appendChild(line('secret-warn-help',SEC_WARN_HELP));
    var href=secWarnHref();
    if(href){
      var a=document.createElement('a'); a.className='secret-warn-link'; a.href=href;
      a.textContent=SEC_WARN_SERVICES;
      box.appendChild(a);
    }
    var controls=document.createElement('div'); controls.className='ask-controls secret-warn-controls';
    var rm=document.createElement('button'); rm.type='button'; rm.className='primary secret-warn-remove';
    rm.textContent=SEC_WARN_REMOVE;
    rm.onclick=function(){ secretWarnRemove(); };
    var send=document.createElement('button'); send.type='button'; send.className='secret-warn-send';
    send.textContent=SEC_WARN_SEND;
    send.onclick=function(){ secretWarnChoose('strip'); };
    var keep=document.createElement('button'); keep.type='button'; keep.className='secret-warn-keep';
    keep.textContent=SEC_WARN_KEEP;
    keep.onclick=function(){ secretWarnChoose('keep'); };
    controls.appendChild(rm); controls.appendChild(send); controls.appendChild(keep);
    box.appendChild(controls);
    pane.appendChild(box); pane.hidden=false;
    pinTranscript();
  }
  /* "Remove it": strip the composer, send nothing. The operator can read it and then send. */
  function secretWarnRemove(){
    var t=secWarnPending, on=secWarnAnswer;
    secretWarnClose();
    if(t==null) return;
    if(on){ on('remove'); return; }
    var stripped=secStrip(t);
    var input=el('perch-input');
    if(input){
      input.value=stripped.text;
      input.style.height='auto';
      if(input.focus) input.focus();
    }
    draftSave();                 /* the warning is closed, so the stripped text may be kept */
  }
  /* "Send anyway" / "It's not a secret": one send, carrying this choice only. */
  function secretWarnChoose(ack){
    var t=secWarnPending, on=secWarnAnswer;
    secretWarnClose();
    if(t==null) return;
    if(on){ on(ack); return; }
    sendNow(t,ack);
  }
  /* On paste: the operator should learn before they tap Send. */
  function secretWarnFromComposer(){
    var input=el('perch-input');
    if(!input||!current.sid||secWarnOpenNow()) return;
    var v=String(input.value==null?'':input.value);
    if(secretWarnNeeded(v)) secretWarnDraw(v);
  }
  /* The count note after a send the server stripped ("1 secret removed before sending."). */
  function secretRemovedNote(n){
    var count=Number(n)||0;
    if(count<=0) return '';
    return count===1?SEC_REMOVED_ONE:secWarnFill(SEC_REMOVED,{n:count});
  }
`;
}