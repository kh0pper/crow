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
 *  - Actions use the EXISTING owner routes (dashboard auth + CSRF): Run
 *    scripts is the D20 approve. The card grants no new authority.
 *  - Q2 (plan PR-2 Task 2.4): "Open beside chat" shows the viewer page
 *    (/dashboard/artifacts/view/:id?thread=<this chat>) in a same-origin
 *    iframe — docked beside the chat at >=1024px, a full-screen sheet with
 *    Back below that; "Open in new window" is a target=_blank rel=noopener
 *    link to the same URL. The hub NEVER frames the artifact origin: the
 *    viewer page (its own CSP + canary) does. The pane is per-open, never
 *    persisted, and closing it leaves the chat alone.
 */
export function perchArtifactCardJs(lang = "en") {
  return `
  /* ---- Crow Artifacts chat card (spec v1.6, chat-first PR-1) ------------ */
  var ART_LABEL='${tJs("perch.artifactLabel", lang)}';
  var ART_OPEN_BESIDE='${tJs("perch.artifactOpenBeside", lang)}';
  var ART_OPEN_WINDOW='${tJs("perch.artifactOpenWindow", lang)}';
  var ART_PANE_CLOSE='${tJs("perch.artifactPaneClose", lang)}';
  var ART_PANE_BACK='${tJs("perch.artifactPaneBack", lang)}';
  var ART_PANE_TITLE='${tJs("perch.artifactPaneTitle", lang)}';
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
  var ART_LINK_ASK='${tJs("perch.artifactLinkAsk", lang)}';
  var ART_LINK_WHY='${tJs("perch.artifactLinkAskWhy", lang)}';
  var ART_LINK_YES='${tJs("perch.artifactLinkYes", lang)}';
  var ART_LINK_NO='${tJs("perch.artifactLinkNo", lang)}';
  var ART_FB='${tJs("perch.artifactFeedback", lang)}';
  var ART_FB_ONE='${tJs("perch.artifactFeedbackOne", lang)}';
  var ART_FB_SHOW='${tJs("perch.artifactFeedbackShow", lang)}';
  var ART_FB_HIDE='${tJs("perch.artifactFeedbackHide", lang)}';
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

  /* requestId -> node: this chat's pending ask-first link cards (PR-3 3.5). */
  var artAsks={};
  /* roundId -> node: this chat's feedback cards (PR-3 3.8). */
  var artFb={};

  function resetArtifactCards(){ artCards={}; artAsks={}; artFb={}; artBuf=[]; artGen++; closeArtifactPane(); }

  /* The viewer page's URL (same origin). The thread rides along only when it
     is a Perch thread id; the viewer validates it again server-side. */
  function artViewerUrl(id,sid){
    var u='/dashboard/artifacts/view/'+encodeURIComponent(String(id));
    if(typeof sid==='string'&&/^perchlive-[0-9a-f]{8}$/.test(sid)) u+='?thread='+encodeURIComponent(sid);
    return u;
  }
  /* Split pane at >=1024px, full-screen sheet below (the breakpoint the
     viewer page's own layout uses). Pure, so tests pin it. */
  function artPaneMode(w){ return Number(w)>=1024?'split':'sheet'; }

  var artPane=null;
  /* Escape closes the pane. Attached only while a pane is open, never at
     script load: every Turbo visit re-runs this script, and a load-time
     document listener would pile up one per visit (perch-hub-stream-leak). */
  function artPaneKey(e){ if(e.key==='Escape'&&artPane) closeArtifactPane(); }
  function closeArtifactPane(){
    if(!artPane) return;
    document.removeEventListener('keydown',artPaneKey);
    if(artPane.parentNode) artPane.parentNode.removeChild(artPane);
    artPane=null;
    document.body.classList.remove('perch-art-split');
    document.body.classList.remove('perch-art-sheet');
  }
  function openArtifactPane(id,sid){
    closeArtifactPane();
    var mode=artPaneMode(window.innerWidth);
    var p=document.createElement('div'); p.id='perch-art-pane'; p.className='art-pane art-pane-'+mode;
    p.setAttribute('role','dialog'); p.setAttribute('aria-label',ART_PANE_TITLE);
    var bar=document.createElement('div'); bar.className='art-pane-bar';
    var back=document.createElement('button'); back.type='button'; back.className='art-pane-close';
    back.textContent=mode==='split'?ART_PANE_CLOSE:ART_PANE_BACK;
    back.onclick=closeArtifactPane;
    bar.appendChild(back);
    var win=document.createElement('a'); win.className='art-pane-window';
    win.href=artViewerUrl(id,sid); win.target='_blank'; win.rel='noopener'; win.textContent=ART_OPEN_WINDOW;
    bar.appendChild(win);
    p.appendChild(bar);
    var f=document.createElement('iframe'); f.className='art-pane-frame';
    f.title=ART_PANE_TITLE; f.src=artViewerUrl(id,sid);
    f.setAttribute('referrerpolicy','same-origin');
    p.appendChild(f);
    (document.getElementById('perch-hub-root')||document.body).appendChild(p);
    document.body.classList.add(mode==='split'?'perch-art-split':'perch-art-sheet');
    artPane=p;
    document.addEventListener('keydown',artPaneKey);
    back.focus();
  }

  function artApi(method,path,body){
    var opts={method:method,headers:{'X-Crow-Csrf':csrf()}};
    if(body!==undefined){ opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
    return fetch('/api/artifacts'+path,opts).then(function(r){
      return r.json().catch(function(){return null;}).then(function(j){ return {ok:r.ok,status:r.status,j:j}; });
    },function(){ return {ok:false,status:0,j:null}; });
  }

  /* An SSE artifact frame: a pointer only — refetch the row. A link-ask or
     link-decided frame refetches this chat's PENDING requests instead: the
     artifact is not linked here (yet), so it draws no artifact card. */
  function artifactFrame(d,sid){
    if(!d||typeof d.artifactId!=='string'||!d.artifactId) return;
    if(d.event==='link-ask'||d.event==='link-decided'){ loadLinkAsks(sid); return; }
    artifactRefetch(d.artifactId,sid);
    /* The bot is acting on this chat's artifact: a round it received may
       have just landed — pick up any new feedback card. */
    loadFeedbackCards(sid);
  }

  /* Feedback cards (spec v1.6 D25, plan PR-3 Task 3.8): one per round
     DELIVERED to this chat, keyed by round id (two rounds, two cards; never
     re-bound). Store-derived: the owner-only list route serves trusted
     rounds only, and the expand shows the round snapshot's owner comments
     from the card route. Text is placed with textContent. */
  function loadFeedbackCards(sid){
    var gen=artGen;
    return artApi('GET','/rounds-by-thread/'+encodeURIComponent(sid)).then(function(r){
      if(!live()||current.sid!==sid||gen!==artGen) return;
      var list=(r.ok&&r.j&&Array.isArray(r.j.cards))?r.j.cards:[];
      list.forEach(function(c){ if(c&&Number.isInteger(c.roundId)&&!artFb[c.roundId]) drawFeedbackCard(c,sid); });
    });
  }
  function drawFeedbackCard(c,sid){
    var tr=el('perch-transcript'); if(!tr) return;
    var node=document.createElement('div'); node.className='entry artfb';
    var k=Number(c.count)||0;
    var ct=String(c.title||'');
    var head=(k===1?ART_FB_ONE:ART_FB).replace('{n}',String(Number(c.version)||0)).replace('{k}',String(k)).replace('{title}',function(){ return ct; });
    node.appendChild(line('art-eyebrow',ART_LABEL));
    node.appendChild(line('art-title',head));
    var body=document.createElement('div'); body.className='art-fb-body';
    var toggle=document.createElement('button'); toggle.type='button'; toggle.className='art-fb-toggle'; toggle.textContent=ART_FB_SHOW;
    var shown=false;
    toggle.onclick=function(){
      if(shown){ clearEl(body); shown=false; toggle.textContent=ART_FB_SHOW; return; }
      toggle.disabled=true;
      var gen=artGen;
      artApi('GET','/rounds/'+encodeURIComponent(String(c.roundId))+'/card').then(function(r){
        if(!live()||current.sid!==sid||gen!==artGen) return;
        toggle.disabled=false;
        if(!r.ok||!r.j||!Array.isArray(r.j.threads)){ body.appendChild(line('art-err',ART_FAILED)); return; }
        clearEl(body);
        r.j.threads.forEach(function(t){
          body.appendChild(line('art-fb-anchor',String((t&&t.anchor)||'')));
          ((t&&Array.isArray(t.comments))?t.comments:[]).forEach(function(x){ body.appendChild(line('art-fb-comment',String(x))); });
        });
        shown=true; toggle.textContent=ART_FB_HIDE;
      });
    };
    var acts=document.createElement('div'); acts.className='art-actions'; acts.appendChild(toggle);
    node.appendChild(acts);
    node.appendChild(body);
    artFb[c.roundId]=node;
    /* Review L9: on reload the history rows carry their time (data-ts), so
       the card goes back where the round was delivered: before the first
       message newer than the round. A card newer than every stamped row
       (a live delivery) still lands at the end, scrolled into view. */
    var ref=fbPlace(tr,c.at);
    if(ref){ tr.insertBefore(node,ref); return; }
    tr.appendChild(node); tr.scrollTop=tr.scrollHeight;
  }
  function fbPlace(tr,at){
    var t=Date.parse(String(at||'').replace(' ','T')+'Z');
    if(!isFinite(t)) return null;
    var kids=tr.children||[];
    for(var i=0;i<kids.length;i++){
      var ts=Number(kids[i].getAttribute&&kids[i].getAttribute('data-ts'));
      if(ts&&ts>t) return kids[i];
    }
    return null;
  }

  /* Ask-first linking (spec v1.6 D25, plan PR-3 Task 3.5): a bot asked to
     link one of its artifacts to this chat. The card is drawn from the
     owner-only pending list (never from the frame); Yes/No ride the owner's
     decide route (dashboard auth + CSRF). Only Yes links; then the artifact
     card draws like any linked artifact's. */
  function loadLinkAsks(sid){
    var gen=artGen;
    return artApi('GET','/link-requests?thread='+encodeURIComponent(sid)).then(function(r){
      if(!live()||current.sid!==sid||gen!==artGen) return;
      var list=(r.ok&&r.j&&Array.isArray(r.j.requests))?r.j.requests:[];
      var still={};
      list.forEach(function(q){
        if(!q||!Number.isInteger(q.id)||typeof q.artifactId!=='string') return;
        still[q.id]=true;
        if(!artAsks[q.id]) drawLinkAsk(q,sid);
      });
      /* Decided elsewhere (another tab, the frame of a decision): drop it. */
      Object.keys(artAsks).forEach(function(k){
        if(!still[k]){ var n=artAsks[k]; if(n&&n.parentNode) n.parentNode.removeChild(n); delete artAsks[k]; }
      });
    });
  }
  function drawLinkAsk(q,sid){
    var tr=el('perch-transcript'); if(!tr) return;
    var node=document.createElement('div'); node.className='entry artask';
    node.appendChild(line('art-eyebrow',ART_LABEL));
    /* Review L6: authored values go in with a function replacer (no $-pattern
       expansion), and the title last (a title holding {bot} stays literal). */
    var qt=String(q.title||''), qb=String(q.botId||'');
    node.appendChild(line('art-title',ART_LINK_ASK.replace('{title}',function(){ return qt; })));
    node.appendChild(line('art-meta',ART_LINK_WHY.replace('{bot}',function(){ return qb; })));
    var acts=document.createElement('div'); acts.className='art-actions';
    var decide=function(accept){
      return function(){
        yes.disabled=true; no.disabled=true;
        var gen=artGen;
        artApi('POST','/link-requests/'+encodeURIComponent(String(q.id))+'/decide',{accept:accept}).then(function(r){
          if(!live()||current.sid!==sid||gen!==artGen) return;
          if(r.ok||r.status===409){
            if(node.parentNode) node.parentNode.removeChild(node);
            delete artAsks[q.id];
            if(r.ok&&accept) artifactRefetch(q.artifactId,sid);
          } else {
            yes.disabled=false; no.disabled=false;
            node.appendChild(line('art-err',ART_FAILED));
          }
        });
      };
    };
    var yes=document.createElement('button'); yes.type='button'; yes.className='art-link-yes'; yes.textContent=ART_LINK_YES; yes.onclick=decide(true);
    var no=document.createElement('button'); no.type='button'; no.className='art-link-no'; no.textContent=ART_LINK_NO; no.onclick=decide(false);
    acts.appendChild(yes); acts.appendChild(no);
    node.appendChild(acts);
    artAsks[q.id]=node;
    tr.appendChild(node); tr.scrollTop=tr.scrollHeight;
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
        loadLinkAsks(sid);
        loadFeedbackCards(sid);
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
    open.textContent=ART_OPEN_BESIDE;
    open.onclick=function(){ openArtifactPane(a.id,sid); };
    acts.appendChild(open);
    var win=document.createElement('a'); win.className='art-window';
    win.href=artViewerUrl(a.id,sid); win.target='_blank'; win.rel='noopener';
    win.textContent=ART_OPEN_WINDOW;
    acts.appendChild(win);
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
