import { tJs } from "../shared/i18n.js";

/**
 * The floating browser preview: a YouTube-style mini player for the live
 * browser tile (the private engineering notes, brief 2026-10-29).
 *
 * Spliced INSIDE perchHubJs()'s IIFE (client.js) right after browser-tile.js,
 * so it shares that scope: el / live / bindOnce and the tile's btTiles /
 * btLiveKey / btHost / btTakeOver / btCanPoll / btMaybeStart / btStopPoll.
 * The tile calls in through four guarded hooks (typeof checks, so a harness
 * that splices the tile alone runs without this file):
 *   bfSeen(t)    the IntersectionObserver reported t (on screen or not)
 *   bfSync()     the live tile changed (btHeader, btDim, retireBrowserTiles)
 *   bfShowing(t) btCanPoll: a floating tile counts as on screen
 *   bfResize()   the hub's one window resize listener (clamp the position)
 *
 * Rules:
 *  - Emitted inside a template literal: no backtick and no dollar-brace in the
 *    client code; only the tJs interpolations below.
 *  - Nothing server-sent reaches a markup sink: the picture is the tile's own
 *    img src (already checked there), the host lands through textContent.
 *
 * State: at most one mini player per hub instance, for the turn's live tile
 * (btLiveKey) only. It floats while that tile is live, the observer has
 * reported it at least once, and it is off screen; × sets t.noFloat (no
 * float again this turn); done, a drop or a new transcript sends it back
 * (a 200 ms fade). Expanded (full screen) stays up until closed, Escape, or
 * the tile stops being live.
 *
 * DOM (appended to #perch-hub-root):
 *   div#perch-bfloat.ph-bfloat[role=group|dialog][data-expanded][data-dim][data-leaving]
 *     button.bf-frame > img.bf-img   tap: full screen
 *     button.bf-grow, button.bf-close  the mini player's ⤢ and ×
 *     div.bf-bar > span.bf-dot, span.bf-state, span.bf-host,
 *                  button.bf-take, button.bf-exit (full screen only)
 * Position: left/top px, dragged with pointer events, kept per device in
 * localStorage['crow-perch-bfloat-pos'] (the operator's choice, unclamped)
 * and clamped to the viewport whenever it is shown or the window resizes.
 */
export function perchBrowserFloatJs(lang = "en") {
  return `
  /* ---- floating browser preview (brief 2026-10-29) ---------------------- */
  var BF_LABEL='${tJs("perch.browserFloatLabel", lang)}';
  var BF_EXPAND='${tJs("perch.browserFloatExpand", lang)}';
  var BF_CLOSE='${tJs("perch.browserFloatClose", lang)}';
  var BF_EXIT='${tJs("perch.browserFloatExit", lang)}';
  var BF_MARGIN=8, BF_GAP=12, BF_DRAG_PX=6, BF_FADE_MS=200;
  /* choice: the operator's dragged/stored position; pos: where it sits now */
  var bf={ node:null, t:null, expanded:false, choice:null, pos:null, drag:null, dragged:false, leaveTimer:null };

  /* Keep a w x h box inside a vw x vh viewport, BF_MARGIN from each edge. */
  function bfClamp(p,w,h,vw,vh){
    var x=Number(p&&p.x), y=Number(p&&p.y);
    if(!isFinite(x)) x=0;
    if(!isFinite(y)) y=0;
    var maxX=Math.max(BF_MARGIN,vw-w-BF_MARGIN), maxY=Math.max(BF_MARGIN,vh-h-BF_MARGIN);
    return { x:Math.round(Math.min(Math.max(x,BF_MARGIN),maxX)), y:Math.round(Math.min(Math.max(y,BF_MARGIN),maxY)) };
  }
  function bfViewport(){ return { w:Number(window.innerWidth)||0, h:Number(window.innerHeight)||0 }; }
  function bfSize(){ var n=bf.node; return { w:(n&&n.offsetWidth)||160, h:(n&&n.offsetHeight)||130 }; }
  function bfLoad(){
    try{
      var p=JSON.parse(window.localStorage.getItem('crow-perch-bfloat-pos')||'null');
      if(p&&typeof p.x==='number'&&typeof p.y==='number'&&isFinite(p.x)&&isFinite(p.y)) return { x:p.x, y:p.y };
    }catch(e){}
    return null;
  }
  function bfSave(p){ try{ window.localStorage.setItem('crow-perch-bfloat-pos',JSON.stringify({ x:p.x, y:p.y })); }catch(e){} }
  /* Bottom right, above the composer (and so above the phone's tab bar). */
  function bfDefault(){
    var v=bfViewport(), s=bfSize(), c=el('perch-composer'), top=v.h;
    if(c&&c.getBoundingClientRect){ var r=c.getBoundingClientRect(); if(r&&r.top>0&&r.top<v.h) top=r.top; }
    return { x:v.w-s.w-BF_GAP, y:top-s.h-BF_GAP };
  }
  function bfPlace(p){
    var v=bfViewport(), s=bfSize();
    bf.pos=bfClamp(p,s.w,s.h,v.w,v.h);
    bf.node.style.left=bf.pos.x+'px'; bf.node.style.top=bf.pos.y+'px';
  }

  function bfButton(cls,text,label){
    var b=document.createElement('button'); b.type='button'; b.className=cls; b.textContent=text;
    if(label){ b.setAttribute('aria-label',label); b.setAttribute('title',label); }
    return b;
  }
  function bfEnsure(){
    if(bf.node) return;
    /* a node an older instance left behind (a Turbo snapshot) goes first */
    var old=el('perch-bfloat'); if(old&&old.parentNode) old.parentNode.removeChild(old);
    var node=document.createElement('div'); node.className='ph-bfloat'; node.id='perch-bfloat'; node.hidden=true;
    node.setAttribute('role','group');
    var frame=bfButton('bf-frame','',BF_EXPAND);
    var img=document.createElement('img'); img.className='bf-img'; img.alt='';
    frame.appendChild(img);
    var grow=bfButton('bf-grow','\\u2922',BF_EXPAND);
    var close=bfButton('bf-close','\\u00d7',BF_CLOSE);
    var bar=document.createElement('div'); bar.className='bf-bar';
    var dot=document.createElement('span'); dot.className='bf-dot'; dot.setAttribute('aria-hidden','true');
    var st=document.createElement('span'); st.className='bf-state'; st.textContent=BT_LIVE;
    var host=document.createElement('span'); host.className='bf-host';
    var take=bfButton('bf-take btn btn-primary',BT_TAKE_OVER,null); take.hidden=true;
    var exit=bfButton('bf-exit btn btn-secondary',BF_EXIT,null); exit.hidden=true;
    bar.appendChild(dot); bar.appendChild(st); bar.appendChild(host); bar.appendChild(take); bar.appendChild(exit);
    node.appendChild(frame); node.appendChild(grow); node.appendChild(close); node.appendChild(bar);
    bf.node=node; bf.frame=frame; bf.img=img; bf.grow=grow; bf.close=close; bf.host=host; bf.take=take; bf.exit=exit;
    frame.onclick=function(){
      if(bf.dragged){ bf.dragged=false; return; }    /* the end of a drag is not a tap */
      bfExpand();
    };
    grow.onclick=bfExpand;
    exit.onclick=bfCollapse;
    close.onclick=function(){ var t=bf.t; if(!t) return; t.noFloat=true; bfSync(); };
    take.onclick=function(){ var t=bf.t; if(!t) return; bfCollapse(); btTakeOver(t); };
    node.onpointerdown=bfDown; node.onpointermove=bfMove; node.onpointerup=bfUp; node.onpointercancel=bfUp;
    (el('perch-hub-root')||document.body).appendChild(node);
  }

  /* The tile's picture, host and state, mirrored. */
  function bfFill(t){
    var src=t.frame.hidden?'':String(t.img.src||'');
    if(src){ if(bf.img.src!==src) bf.img.src=src; bf.img.hidden=false; }
    else { bf.img.removeAttribute('src'); bf.img.hidden=true; }
    var host=btHost(t.domain);
    if(bf.host.textContent!==host) bf.host.textContent=host;
    bf.img.alt=host;
    bf.node.setAttribute('aria-label',BF_LABEL+' \\u00b7 '+host);
    if(t.operator||t.node.getAttribute('data-dim')==='1') bf.node.setAttribute('data-dim','1');
    else bf.node.removeAttribute('data-dim');
  }

  /* The tile that should float right now, or null. */
  function bfWant(){
    if(!live()) return null;
    var t=btLiveKey?btTiles[btLiveKey]:null;
    if(!t||t.phase!=='live'||t.noFloat||!t.bfSeen) return null;
    if(bf.expanded&&bf.t===t) return t;            /* full screen stays until closed */
    return t.onScreen?null:t;
  }
  function bfShowing(t){ return !!t&&bf.t===t&&!!bf.node&&!bf.node.hidden; }
  function bfSeen(t){ t.bfSeen=true; bfSync(); }
  function bfSync(){
    if(!live()){ bfRemove(); return; }
    var t=bfWant(), old=bf.t;
    if(t===old){ if(t) bfFill(t); return; }
    if(old) bfHide();
    if(t) bfShow(t);
    /* the poll gate moved: a tile that stopped floating off screen stops, a new float starts */
    if(old&&!btCanPoll(old)) btStopPoll(old);
    if(t) btMaybeStart(t);
  }
  function bfShow(t){
    bfEnsure();
    if(bf.leaveTimer){ clearTimeout(bf.leaveTimer); bf.leaveTimer=null; }
    bf.t=t; bfFill(t);
    bf.node.removeAttribute('data-leaving'); bf.node.hidden=false;
    bfPlace(bf.choice||(bf.choice=bfLoad())||bfDefault());
  }
  /* Back into the transcript: a fade, then hidden. Focus that was inside goes to the composer. */
  function bfHide(){
    var n=bf.node, a=document.activeElement;
    var had=!!(n&&a&&n.contains&&n.contains(a));
    if(bf.expanded) bfSetExpanded(false);
    bf.t=null; bf.drag=null;
    if(!n||n.hidden) return;
    n.setAttribute('data-leaving','1');
    if(bf.leaveTimer) clearTimeout(bf.leaveTimer);
    bf.leaveTimer=setTimeout(function(){
      bf.leaveTimer=null;
      if(bf.t||bf.node!==n) return;
      n.hidden=true; n.removeAttribute('data-leaving'); bf.img.removeAttribute('src');
    },BF_FADE_MS);
    if(had){ var inp=el('perch-input'); if(inp&&inp.focus) inp.focus(); }
  }
  /* A retired instance or a Turbo snapshot: gone at once. */
  function bfRemove(){
    if(bf.leaveTimer){ clearTimeout(bf.leaveTimer); bf.leaveTimer=null; }
    if(bf.node&&bf.node.parentNode) bf.node.parentNode.removeChild(bf.node);
    bf.node=null; bf.t=null; bf.expanded=false; bf.drag=null;
  }

  /* ---- full screen ------------------------------------------------------ */
  function bfSetExpanded(on){
    var n=bf.node; bf.expanded=on;
    if(on){ n.setAttribute('data-expanded','1'); n.setAttribute('role','dialog'); n.setAttribute('aria-modal','true'); bf.frame.setAttribute('tabindex','-1'); }
    else { n.removeAttribute('data-expanded'); n.setAttribute('role','group'); n.removeAttribute('aria-modal'); bf.frame.removeAttribute('tabindex'); }
    bf.take.hidden=!on; bf.exit.hidden=!on; bf.grow.hidden=on; bf.close.hidden=on;
  }
  function bfExpand(){
    if(!bf.t||bf.expanded) return;
    bfSetExpanded(true);
    if(bf.exit.focus) bf.exit.focus();
  }
  /* Back to the mini player, focus on it (or, if the tile is on screen by now, home inline). */
  function bfCollapse(){
    if(!bf.expanded) return;
    bfSetExpanded(false);
    bfSync();
    if(bf.t&&bf.frame.focus) bf.frame.focus();
  }
  bindOnce(document,'keydown','bfKey',function(ev){
    if(!live()||!bf.expanded||!ev||ev.key!=='Escape') return;
    if(ev.preventDefault) ev.preventDefault();
    bfCollapse();
  });
  bindOnce(document,'turbo:before-cache','bfCache',function(){ if(live()) bfRemove(); });

  /* ---- drag ------------------------------------------------------------- */
  function bfDown(ev){
    if(!bf.t||bf.expanded||!ev||(ev.button!=null&&ev.button>0)) return;
    var tg=ev.target;
    if(tg===bf.grow||tg===bf.close) return;
    bf.dragged=false;
    var p=bf.pos||{ x:0, y:0 };
    bf.drag={ id:ev.pointerId, sx:Number(ev.clientX)||0, sy:Number(ev.clientY)||0, x:p.x, y:p.y, moved:false };
  }
  function bfMove(ev){
    var d=bf.drag; if(!d||!ev||ev.pointerId!==d.id) return;
    var dx=(Number(ev.clientX)||0)-d.sx, dy=(Number(ev.clientY)||0)-d.sy;
    if(!d.moved&&Math.abs(dx)<BF_DRAG_PX&&Math.abs(dy)<BF_DRAG_PX) return;
    if(!d.moved){
      /* captured only once it is a drag: a capture from pointerdown would
         retarget a plain tap's click away from the picture */
      try{ if(bf.node.setPointerCapture) bf.node.setPointerCapture(d.id); }catch(e){}
    }
    d.moved=true; bf.dragged=true;
    if(ev.preventDefault) ev.preventDefault();
    bfPlace({ x:d.x+dx, y:d.y+dy });
  }
  function bfUp(ev){
    var d=bf.drag; if(!d||!ev||ev.pointerId!==d.id) return;
    bf.drag=null;
    if(!d.moved) return;
    bf.choice={ x:bf.pos.x, y:bf.pos.y }; bfSave(bf.choice);
    /* a click that ends the drag lands before this timer and is skipped; the next tap expands */
    setTimeout(function(){ bf.dragged=false; },0);
  }
  /* Rotation or a resized window: back inside the viewport (the stored choice is kept). */
  function bfResize(){ if(bf.node&&!bf.node.hidden&&bf.t&&!bf.expanded) bfPlace(bf.choice||bfDefault()); }
`;
}
