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
