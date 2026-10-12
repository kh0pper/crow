import { tJs } from "../shared/i18n.js";

/**
 * The Crow Artifacts chat card (spec v1.6 D25/D27; chat-first plan PR-1).
 *
 * Spliced INSIDE perchHubJs()'s IIFE (client.js), so it shares that scope's
 * el / line / clearEl / csrf / live / current / histSettled. Kept in its own
 * module (the phone-card.js pattern) so client.js only carries one-line hooks.
 *
 * Rules (house + spec):
 *  - Emitted inside a template literal: no backtick and no dollar-brace in the
 *    client code; only the tJs interpolations below.
 *  - I2 pattern: an SSE `artifact` frame is a POINTER ({artifactId, n,
 *    event}); every card is built from the store row refetched with
 *    GET /api/artifacts/:id. Bot-authored strings (titles, change notes)
 *    never ride frames and are never parsed here.
 *  - I6 pattern: createElement/textContent only — a title is bot-controlled
 *    text, never markup.
 *  - Replay: after the transcript settles, cards redraw from the bundle's
 *    by-thread route, one refetch per artifact, oldest first. One node per
 *    artifact (upsert, key-checked) dedupes replay against live frames.
 *  - Actions use the EXISTING owner routes (dashboard auth + CSRF): Open
 *    navigates to the Artifacts page (PR-2 repoints it to the viewer page and
 *    adds beside-chat/new-window), Run scripts is the D20 approve. The card
 *    grants no new authority.
 */
export function perchArtifactCardJs(lang = "en") {
  return `
  /* ---- Crow Artifacts chat card (spec v1.6, chat-first PR-1) ------------ */
  var ART_LABEL='${tJs("perch.artifactLabel", lang)}';
  var ART_OPEN='${tJs("perch.artifactOpen", lang)}';
  var ART_RUN='${tJs("perch.artifactRunScripts", lang)}';
  var ART_ST_READY='${tJs("perch.artifactStateReady", lang)}';
  var ART_ST_REVISING='${tJs("perch.artifactStateRevising", lang)}';
  var ART_ST_SCRIPTS_OFF='${tJs("perch.artifactStateScriptsOff", lang)}';
  var ART_ST_FLAGGED='${tJs("perch.artifactStateFlagged", lang)}';
  var ART_ST_PROPOSED='${tJs("perch.artifactStateProposed", lang)}';
  var ART_COMMENTS='${tJs("perch.artifactOpenComments", lang)}';
  var ART_CONTACT='${tJs("perch.artifactContactComments", lang)}';
  var ART_FAILED='${tJs("perch.artifactActionFailed", lang)}';
  var ART_GONE='${tJs("perch.artifactGone", lang)}';
  var ART_TYPES={ page:'${tJs("perch.artifactTypePage", lang)}', document:'${tJs("perch.artifactTypeDocument", lang)}', diagram:'${tJs("perch.artifactTypeDiagram", lang)}' };

  /* artifactId -> {node,key} for THIS transcript. Dies with the transcript at
     the same seams as fileSeen and phoneCards. */
  var artCards={};
  /* artifact frames that arrived before the history settled; loadArtifactCards
     replays them once the by-thread batch lands, so a card never sits above
     the transcript it belongs under. */
  var artBuf=[];
  /* Bumped at every transcript reset: a fetch that started before the reset
     carries the old value and is dropped (the phone-card P12 discipline). */
  var artGen=0;
  /* A 404 on the by-thread route means no artifacts bundle on this gateway:
     stop asking for this document. */
  var artNoBundle=false;

  function resetArtifactCards(){ artCards={}; artBuf=[]; artGen++; }

  function artApi(method,path,body){
    var opts={method:method,headers:{'X-Crow-Csrf':csrf()}};
    if(body!==undefined){ opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
    return fetch('/api/artifacts'+path,opts).then(function(r){
      return r.json().catch(function(){return null;}).then(function(j){ return {ok:r.ok,status:r.status,j:j}; });
    },function(){ return {ok:false,status:0,j:null}; });
  }

  /* An SSE artifact frame: a pointer only — refetch the row. */
  function artifactFrame(d,sid){
    if(!d||typeof d.artifactId!=='string'||!d.artifactId) return;
    artifactRefetch(d.artifactId,sid);
  }
  function artifactRefetch(id,sid){
    var gen=artGen;
    return artApi('GET','/'+encodeURIComponent(id)).then(function(r){
      if(!live()||current.sid!==sid||gen!==artGen) return r;
      if(r.ok&&r.j&&r.j.artifact){ upsertArtifactCard(r.j,sid); return r; }
      /* Gone (deleted, or no longer visible to the owner): an already-drawn
         card says so honestly; nothing new is drawn. */
      var rec=artCards[id];
      if(rec&&r.status===404&&rec.key!=='gone'){
        clearEl(rec.node); rec.key='gone';
        rec.node.appendChild(line('art-gone',ART_GONE));
      }
      return r;
    });
  }
  /* Reload replay: the bundle's by-thread route lists this chat's artifact
     events (audit-derived, oldest first, capped); one refetch per DISTINCT
     artifact draws the card, then buffered live frames replay through the
     same upsert. 404 = no artifacts bundle here: no cards, stop probing. */
  function loadArtifactCards(sid){
    var buf=artBuf, gen=artGen; artBuf=[];
    if(artNoBundle){ buf.forEach(function(d){ artifactFrame(d,sid); }); return; }
    artApi('GET','/by-thread/'+encodeURIComponent(sid)).then(function(r){
      if(!live()||current.sid!==sid||gen!==artGen) return;
      if(r.status===404){ artNoBundle=true; return; }
      var items=(r.ok&&r.j&&Array.isArray(r.j.items))?r.j.items:[];
      var seen={}, order=[];
      items.forEach(function(it){
        if(it&&typeof it.artifactId==='string'&&it.artifactId&&!seen[it.artifactId]){ seen[it.artifactId]=true; order.push(it.artifactId); }
      });
      var chain=Promise.resolve();
      order.forEach(function(id){ chain=chain.then(function(){ return artifactRefetch(id,sid); }); });
      chain.then(function(){
        if(!live()||current.sid!==sid||gen!==artGen) return;
        buf.forEach(function(d){ artifactFrame(d,sid); });
      });
    });
  }

  /* The card's facts, derived from the GET :id payload ONLY. Pure, so tests
     pin every state without a DOM. Chip precedence: flagged > revising >
     proposed > scripts-off > ready. scriptsOff/flagged come from the server
     (policy + store), never re-derived here. */
  function artifactCardState(row){
    var a=(row&&row.artifact)||{};
    var vs=(row&&Array.isArray(row.versions))?row.versions:[];
    var ths=(row&&Array.isArray(row.threads))?row.threads:[];
    var cur=null;
    for(var i=0;i<vs.length;i++){ if(Number(vs[i].n)===Number(a.current_version)){ cur=vs[i]; break; } }
    var proposed=null;
    for(var j=0;j<vs.length;j++){ if(vs[j]&&vs[j].state==='proposed'){ proposed=vs[j]; break; } }
    var flagged=!!(cur&&cur.flagged_reason);
    var scriptsOff=!!row&&row.scriptsOff===true;
    var round=(row&&row.activeRound)||null;
    var open=0, contactOpen=0, who='';
    for(var k=0;k<ths.length;k++){
      var t=ths[k]; if(!t||t.status==='resolved') continue;
      open++;
      if(t.author_kind==='contact'){
        contactOpen++;
        if(!who&&typeof t.author_id==='string'&&t.author_id){
          who=t.author_id.split(/[^\\p{L}\\p{N}]/u)[0].slice(0,20);
        }
      }
    }
    var type=String(a.type||'');
    var typeLabel=Object.prototype.hasOwnProperty.call(ART_TYPES,type)?ART_TYPES[type]:type;
    var chip,pill;
    if(flagged){ chip=ART_ST_FLAGGED; pill='err'; }
    else if(round){ chip=ART_ST_REVISING.replace('{n}',String(Number(round.id)||0)); pill='wait'; }
    else if(proposed){ chip=ART_ST_PROPOSED.replace('{n}',String(Number(proposed.n)||0)); pill='warn'; }
    else if(scriptsOff){ chip=ART_ST_SCRIPTS_OFF; pill='warn'; }
    else { chip=ART_ST_READY; pill='ok'; }
    var curN=cur?Number(cur.n):(a.current_version==null?null:Number(a.current_version));
    var key=[String(a.title||''),type,String(curN),chip,String(scriptsOff),String(flagged),
      proposed?String(Number(proposed.n)):'',round?String(Number(round.id)):'',
      String(open),String(contactOpen),who].join('|');
    return { key:key, typeLabel:typeLabel, chip:chip, pill:pill, curN:curN,
      flagged:flagged, scriptsOff:scriptsOff, showRun:scriptsOff&&!flagged&&curN!=null,
      proposedN:proposed?Number(proposed.n):null, roundId:round?Number(round.id):null,
      openComments:open, contactOpen:contactOpen, contactWho:who };
  }

  function artShell(id){
    var tr=el('perch-transcript'); if(!tr) return null;
    var rec=artCards[id];
    if(!rec){
      rec=artCards[id]={node:document.createElement('div'),key:''};
      rec.node.className='entry artcard';
      tr.appendChild(rec.node); tr.scrollTop=tr.scrollHeight;
    }
    return rec;
  }

  function upsertArtifactCard(row,sid){
    var a=(row&&row.artifact)||null;
    if(!a||typeof a.id!=='string'||!a.id) return;
    var st=artifactCardState(row);
    var rec=artShell(a.id); if(!rec) return;
    if(rec.key===st.key) return;              /* unchanged: do not churn the DOM */
    rec.key=st.key;
    clearEl(rec.node);
    var head=document.createElement('div'); head.className='art-head';
    head.appendChild(line('art-eyebrow',ART_LABEL));
    head.appendChild(line('art-type',st.typeLabel));
    var pill=document.createElement('span'); pill.className='art-pill art-pill-'+st.pill;
    pill.textContent=st.chip;
    head.appendChild(pill);
    rec.node.appendChild(head);
    rec.node.appendChild(line('art-title',String(a.title||'')));
    rec.node.appendChild(line('art-meta','v'+String(st.curN==null?'?':st.curN)));
    if(st.openComments>0||st.contactOpen>0){
      var parts=[];
      if(st.openComments>0) parts.push(ART_COMMENTS.replace('{n}',String(st.openComments)));
      if(st.contactOpen>0) parts.push(ART_CONTACT.replace('{n}',String(st.contactOpen)).replace('{who}',st.contactWho||'?'));
      rec.node.appendChild(line('art-badges',parts.join(' · ')));
    }
    var acts=document.createElement('div'); acts.className='art-actions';
    var open=document.createElement('button'); open.type='button'; open.className='art-open';
    open.textContent=ART_OPEN;
    open.onclick=function(){ location.href='/dashboard/artifacts?id='+encodeURIComponent(a.id); };
    acts.appendChild(open);
    if(st.showRun){
      var run=document.createElement('button'); run.type='button'; run.className='art-run';
      run.textContent=ART_RUN;
      run.onclick=function(){
        run.disabled=true;
        var gen=artGen;   /* L4 (plan review): a same-sid reset mid-approve detaches this card */
        artApi('POST','/'+encodeURIComponent(a.id)+'/versions/'+encodeURIComponent(String(st.curN))+'/approve',{}).then(function(r){
          if(!live()||current.sid!==sid||gen!==artGen) return;
          if(r.ok){ artifactRefetch(a.id,sid); }
          else{
            run.disabled=false;
            var e=line('art-err',ART_FAILED);
            rec.node.appendChild(e);
          }
        });
      };
      acts.appendChild(run);
    }
    rec.node.appendChild(acts);
    var tr=el('perch-transcript'); if(tr) tr.scrollTop=tr.scrollHeight;
  }
`;
}
