/**
 * Board tab client: on the phone the lanes are a tab view (chips are the
 * tabs, one lane in view at a time), so the chips get role=tablist/tab and
 * the lanes role=tabpanel, with aria-selected following the lane in view.
 * Those roles exist only while matchMedia("(max-width: 1023px)") matches and
 * are removed when it stops matching: on the desktop the four lanes are plain
 * labelled regions side by side.
 *
 * Without JS the chips are plain in-page links, and everything still reads.
 * Turbo Drive re-runs this per visit and on a restored snapshot (the init
 * flag is cleared before Turbo caches the page); it binds to the board element
 * it finds and lets go of its media listener when Turbo swaps the page out.
 *
 * NOTE: this returns template-literal code: never use a backtick inside it.
 */

export function boardClientJs() {
  return laneTabsJs() + laneMovesJs();
}

function laneTabsJs() {
  return `<script>(function(){
  var root=document.querySelector('[data-sb-board]');
  if(!root||root.getAttribute('data-sb-init')) return;
  root.setAttribute('data-sb-init','1');
  var chipsBox=root.querySelector('.sb-chips');
  var lanesBox=root.querySelector('.sb-lanes');
  if(!chipsBox||!lanesBox||!window.matchMedia) return;
  var chips=[].slice.call(chipsBox.querySelectorAll('.sb-chip'));
  var lanes=[].slice.call(lanesBox.querySelectorAll('.sb-lane'));
  var mq=window.matchMedia('(max-width: 1023px)');

  function inView(){
    var x=lanesBox.scrollLeft, best=0, bestD=Infinity;
    for(var i=0;i<lanes.length;i++){
      var d=Math.abs(lanes[i].offsetLeft-x);
      if(d<bestD){ bestD=d; best=i; }
    }
    return best;
  }
  function select(idx){
    if(!mq.matches) return;
    for(var i=0;i<chips.length;i++){
      chips[i].setAttribute('aria-selected', i===idx ? 'true' : 'false');
      chips[i].setAttribute('tabindex', i===idx ? '0' : '-1');
    }
  }
  function apply(){
    if(mq.matches){
      chipsBox.setAttribute('role','tablist');
      for(var i=0;i<chips.length;i++){
        chips[i].setAttribute('role','tab');
        chips[i].id='sb-chip-'+chips[i].getAttribute('data-lane');
      }
      for(var j=0;j<lanes.length;j++){
        lanes[j].setAttribute('role','tabpanel');
        lanes[j].setAttribute('tabindex','0');
      }
      select(inView());
    } else {
      chipsBox.removeAttribute('role');
      for(var k=0;k<chips.length;k++){
        chips[k].removeAttribute('role');
        chips[k].removeAttribute('aria-selected');
        chips[k].removeAttribute('tabindex');
        chips[k].removeAttribute('id');
      }
      for(var m=0;m<lanes.length;m++){
        lanes[m].removeAttribute('role');
        lanes[m].removeAttribute('tabindex');
      }
    }
  }
  function show(idx, focus){
    var lane=lanes[idx];
    if(!lane) return;
    lanesBox.scrollTo({ left: lane.offsetLeft, behavior: 'smooth' });
    select(idx);
    if(focus&&chips[idx]) chips[idx].focus();
  }
  chips.forEach(function(chip, idx){
    chip.addEventListener('click', function(e){
      if(!mq.matches) return;
      e.preventDefault();
      show(idx, false);
    });
    chip.addEventListener('keydown', function(e){
      if(!mq.matches) return;
      var n=chips.length, to=-1;
      if(e.key==='ArrowRight') to=(idx+1)%n;
      else if(e.key==='ArrowLeft') to=(idx-1+n)%n;
      else if(e.key==='Home') to=0;
      else if(e.key==='End') to=n-1;
      if(to<0) return;
      e.preventDefault();
      show(to, true);
    });
  });
  var pending=false;
  lanesBox.addEventListener('scroll', function(){
    if(pending) return;
    pending=true;
    requestAnimationFrame(function(){ pending=false; select(inView()); });
  }, { passive: true });

  function onChange(){ apply(); }
  if(mq.addEventListener) mq.addEventListener('change', onChange); else mq.addListener(onChange);
  // Turbo caches this page as it stands, flag included; a restored snapshot
  // (Back) must initialise again, so the flag never goes into the cache.
  document.addEventListener('turbo:before-cache', function uncache(){
    root.removeAttribute('data-sb-init');
    document.removeEventListener('turbo:before-cache', uncache);
  });
  document.addEventListener('turbo:before-render', function release(){
    if(mq.removeEventListener) mq.removeEventListener('change', onChange); else mq.removeListener(onChange);
    document.removeEventListener('turbo:before-render', release);
  });
  apply();
})();</script>`;
}

/**
 * Lane moves (Task 3.3). Two paths to one route, POST
 * /dashboard/shell-api/cards/:id/lane { to, from }:
 *   - the Move button on each card opens the sheet (a dialog) with the four
 *     lanes; a refused lane is aria-disabled, with its reason as its
 *     subtitle (and its description), so a keyboard or screen reader user
 *     hears why;
 *   - on a fine pointer, cards can be dragged between lanes; a refused lane
 *     is aria-disabled and shows its reason as the drop hint.
 * The refusals come from the server (data-refuse, movePlan over stored
 * state), and the server decides again on every move. There are no
 * optimistic moves: on success, or when the card had already moved
 * ("stale"), the board is re-rendered from the server with a Turbo visit; a
 * refusal or failure is said in the status line and nothing changes.
 * The face's Accept is the same route (to Done); its Reject is the classic
 * board's decide route. CSRF rides on layout.js's fetch wrapper.
 *
 * NOTE: template-literal code: never use a backtick inside it.
 */
function laneMovesJs() {
  return `<script>(function(){
  var root=document.querySelector('[data-sb-board]');
  if(!root||root.getAttribute('data-sb-move-init')) return;
  root.setAttribute('data-sb-move-init','1');
  var reasons={};
  try{ reasons=JSON.parse(root.getAttribute('data-reasons')||'{}'); }catch(e){ reasons={}; }
  var statusEl=root.querySelector('[data-sb-status]');
  var sheet=root.querySelector('[data-sb-sheet]');
  var lanes=[].slice.call(root.querySelectorAll('.sb-lane'));
  var busy=false;

  function say(text){ if(statusEl) statusEl.textContent=text||''; }
  // A card's lane and refusals ride on its Move button (html.js).
  function moveData(li){ return (li&&li.querySelector('[data-sb-move]'))||null; }
  function fromOf(li){ var m=moveData(li); return m?m.getAttribute('data-from'):null; }
  function refusalsOf(li){
    var m=moveData(li);
    try{ return JSON.parse((m&&m.getAttribute('data-refuse'))||'{}'); }catch(e){ return {}; }
  }
  function rerender(){
    if(window.Turbo&&window.Turbo.visit) window.Turbo.visit(location.href,{action:'replace'});
    else location.reload();
  }
  function post(url, body){
    return fetch(url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return {status:r.status,j:j}; }); });
  }
  function send(li, to){
    if(busy) return;
    var from=fromOf(li);
    if(to===from) return;
    busy=true; say('');
    post('/dashboard/shell-api/cards/'+encodeURIComponent(li.getAttribute('data-card'))+'/lane',{to:to,from:from})
      .then(function(r){
        if(r.status===200||(r.status===409&&r.j&&r.j.error==='stale')){ rerender(); return; }
        busy=false;
        if(r.status===409&&r.j&&r.j.error==='refused') say(reasons[r.j.reason]||reasons.failed);
        else say(reasons.failed);
      }, function(){ busy=false; say(reasons.failed); });
  }

  // ---- the Move sheet ----
  var sheetCard=sheet&&sheet.querySelector('[data-sb-sheet-card]');
  var laneBtns=sheet?[].slice.call(sheet.querySelectorAll('.sb-sheet-lane')):[];
  var current=null, opener=null;
  function openSheet(li, btn){
    if(!sheet) return;
    current=li; opener=btn;
    var from=fromOf(li), refused=refusalsOf(li), first=null;
    var name=li.querySelector('[data-sb-name]');
    if(sheetCard) sheetCard.textContent=name?name.textContent:'';
    laneBtns.forEach(function(b){
      var to=b.getAttribute('data-to'), sub=b.querySelector('.sb-sheet-sub'), why='';
      b.removeAttribute('aria-current');
      if(to===from){ why=reasons.here||''; b.setAttribute('aria-current','true'); }
      else if(refused[to]) why=reasons[refused[to]]||'';
      if(to===from||refused[to]) b.setAttribute('aria-disabled','true');
      else { b.removeAttribute('aria-disabled'); if(!first) first=b; }
      if(sub) sub.textContent=why;
    });
    if(typeof sheet.showModal==='function') sheet.showModal(); else sheet.setAttribute('open','');
    (first||sheet.querySelector('[data-sb-sheet-cancel]')).focus();
  }
  function closeSheet(){
    if(!sheet) return;
    if(typeof sheet.close==='function'&&sheet.open) sheet.close(); else sheet.removeAttribute('open');
  }
  if(sheet){
    sheet.addEventListener('close', function(){ if(opener&&document.contains(opener)) opener.focus(); current=null; opener=null; });
    sheet.addEventListener('click', function(e){
      if(e.target===sheet){ closeSheet(); return; }
      if(e.target.closest('[data-sb-sheet-cancel]')){ closeSheet(); return; }
      var b=e.target.closest('.sb-sheet-lane');
      if(!b||b.getAttribute('aria-disabled')==='true'||!current) return;
      var li=current;
      closeSheet();
      send(li, b.getAttribute('data-to'));
    });
  }

  // ---- card buttons: Move, and the face's Accept / Reject ----
  root.addEventListener('click', function(e){
    var mv=e.target.closest&&e.target.closest('[data-sb-move]');
    if(mv){ e.preventDefault(); openSheet(mv.closest('.sb-card'), mv); return; }
    var ra=e.target.closest&&e.target.closest('[data-result-action]');
    if(!ra) return;
    e.preventDefault();
    var li=ra.closest('.sb-card'), box=ra.closest('[data-result-actions]');
    if(!li||!box||busy) return;
    if(ra.getAttribute('data-result-action')==='accept'){ send(li,'done'); return; }
    busy=true; say('');
    post('/dashboard/bot-board-api/card/'+encodeURIComponent(li.getAttribute('data-card'))+'/result/'+encodeURIComponent(box.getAttribute('data-result-id'))+'/decide',{decision:'rejected'})
      .then(function(r){
        if(r.status===200||r.status===409){ rerender(); return; }
        busy=false; say(reasons.failed);
      }, function(){ busy=false; say(reasons.failed); });
  });

  // ---- drag between lanes (fine pointers) ----
  var fine=window.matchMedia&&window.matchMedia('(hover: hover) and (pointer: fine)');
  var cards=[].slice.call(root.querySelectorAll('.sb-card'));
  function setDraggable(){
    var on=!!(fine&&fine.matches);
    cards.forEach(function(li){ li.setAttribute('draggable', on?'true':'false'); });
  }
  var dragLi=null;
  function laneState(lane){
    if(!dragLi) return 'none';
    var to=lane.getAttribute('data-lane');
    if(to===fromOf(dragLi)) return 'none';
    return refusalsOf(dragLi)[to] ? 'refused' : 'ok';
  }
  function clearDrag(){
    if(dragLi) dragLi.classList.remove('sb-dragging');
    dragLi=null;
    lanes.forEach(function(l){
      l.removeAttribute('aria-disabled');
      l.classList.remove('sb-drop-over');
      var h=l.querySelector('[data-drop-hint]');
      if(h){ h.textContent=''; h.hidden=true; }
    });
  }
  root.addEventListener('dragstart', function(e){
    var li=e.target.closest&&e.target.closest('.sb-card');
    if(!li||li.getAttribute('draggable')!=='true') return;
    dragLi=li; li.classList.add('sb-dragging');
    try{ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', li.getAttribute('data-card')); }catch(err){}
    var refused=refusalsOf(li);
    lanes.forEach(function(l){
      var r=refused[l.getAttribute('data-lane')];
      if(!r) return;
      l.setAttribute('aria-disabled','true');
      var h=l.querySelector('[data-drop-hint]');
      if(h){ h.textContent=reasons[r]||''; h.hidden=false; }
    });
  });
  lanes.forEach(function(l){
    l.addEventListener('dragover', function(e){
      if(laneState(l)!=='ok') return;
      e.preventDefault();
      try{ e.dataTransfer.dropEffect='move'; }catch(err){}
      l.classList.add('sb-drop-over');
    });
    l.addEventListener('dragleave', function(e){
      if(!l.contains(e.relatedTarget)) l.classList.remove('sb-drop-over');
    });
    l.addEventListener('drop', function(e){
      if(laneState(l)!=='ok') return;
      e.preventDefault();
      var li=dragLi;
      clearDrag();
      send(li, l.getAttribute('data-lane'));
    });
  });
  root.addEventListener('dragend', clearDrag);
  function onFine(){ setDraggable(); }
  if(fine){ if(fine.addEventListener) fine.addEventListener('change', onFine); else if(fine.addListener) fine.addListener(onFine); }
  setDraggable();

  document.addEventListener('turbo:before-cache', function uncache(){
    closeSheet(); clearDrag(); say('');
    root.removeAttribute('data-sb-move-init');
    document.removeEventListener('turbo:before-cache', uncache);
  });
  document.addEventListener('turbo:before-render', function release(){
    if(fine){ if(fine.removeEventListener) fine.removeEventListener('change', onFine); else if(fine.removeListener) fine.removeListener(onFine); }
    document.removeEventListener('turbo:before-render', release);
  });
})();</script>`;
}
