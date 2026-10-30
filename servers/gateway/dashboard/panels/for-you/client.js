/**
 * For You's client JS (For You v1): opens a story's sheet, and sends its buttons to Media Hub's
 * own API (same origin, the session cookie, the CSRF header):
 *   More like this  -> POST /api/media/articles/:id/action {action:"thumbs_up"}
 *   Less like this  -> ... {action:"thumbs_down"}, and the story leaves the list
 *   Hide <source>   -> POST /api/media/sources/:id/hidden {hidden:true}, its stories leave the list
 *   Read at <source> -> ... {action:"mark_read"} (fire and forget), so a read story isn't picked again
 *   Show again (customize) -> POST /api/media/sources/:id/hidden {hidden:false}
 *   Play / Pause (Listen) -> the tile's own <audio> element; one plays at a time. A podcast
 *     episode that starts playing is marked read ({action:"mark_read"}), so it leaves the list.
 * Messages come from the page's data-fy-* attributes (server-translated).
 *
 * Emitted inside a template literal: this source must contain NO backticks. It re-runs on every
 * Turbo visit; the page is part of the swapped body, so listeners bind fresh each time.
 */
export function forYouClientJs() {
  return `<script>
(function () {
  var root = document.querySelector('[data-fy]');
  if (!root) return;
  function csrf() {
    var m = document.cookie.match(/(?:^|;\\s*)crow_csrf=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  function post(url, body, keepalive) {
    return fetch(url, {
      method: 'POST', credentials: 'same-origin', keepalive: !!keepalive,
      headers: { 'content-type': 'application/json', 'x-crow-csrf': csrf() },
      body: JSON.stringify(body)
    }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r; });
  }
  function closeSheet(dlg) {
    if (!dlg) return;
    if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
  }
  function removeStories(match) {
    var cards = root.querySelectorAll('[data-fy-story]');
    for (var i = 0; i < cards.length; i++) if (match(cards[i])) cards[i].remove();
  }

  root.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    var play = t.closest('[data-fy-play]');
    if (play) {
      var audio = document.getElementById(play.getAttribute('data-fy-play'));
      if (!audio) return;
      if (!audio.paused) { audio.pause(); return; }
      var all = root.querySelectorAll('audio');
      for (var n = 0; n < all.length; n++) if (all[n] !== audio && !all[n].paused) all[n].pause();
      var started = audio.play();
      if (started && typeof started.catch === 'function') {
        started.catch(function () { play.textContent = root.getAttribute('data-fy-play-failed') || play.textContent; });
      }
      return;
    }
    var opener = t.closest('[data-fy-open]');
    if (opener) {
      var dlg = document.getElementById(opener.getAttribute('data-fy-open'));
      if (!dlg) return;
      dlg.__fyOpener = opener;
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
      return;
    }
    var sheet = t.closest('dialog.fy-sheet');
    if (sheet && t === sheet) { closeSheet(sheet); return; }
    if (t.closest('[data-fy-close]')) { closeSheet(t.closest('dialog')); return; }
    var read = t.closest('[data-fy-read]');
    if (read) {
      post('/api/media/articles/' + encodeURIComponent(read.getAttribute('data-fy-read')) + '/action', { action: 'mark_read' }, true).catch(function () {});
      return;
    }
    var act = t.closest('[data-fy-act]');
    if (act) {
      var kind = act.getAttribute('data-fy-act');
      var article = act.getAttribute('data-article');
      var source = act.getAttribute('data-source');
      var box = act.closest('dialog');
      var status = box ? box.querySelector('[data-fy-status]') : null;
      var btns = box ? box.querySelectorAll('[data-fy-act]') : [];
      for (var b = 0; b < btns.length; b++) btns[b].disabled = true;
      var req = kind === 'hide'
        ? post('/api/media/sources/' + encodeURIComponent(source) + '/hidden', { hidden: true })
        : post('/api/media/articles/' + encodeURIComponent(article) + '/action', { action: kind === 'more' ? 'thumbs_up' : 'thumbs_down' });
      req.then(function () {
        if (status) status.textContent = kind === 'hide' ? act.getAttribute('data-done') : root.getAttribute('data-fy-done-' + kind);
        if (kind === 'less') removeStories(function (c) { return c.getAttribute('data-fy-story') === article; });
        if (kind === 'hide') removeStories(function (c) { return c.getAttribute('data-fy-source') === source; });
      }, function () {
        if (status) status.textContent = root.getAttribute('data-fy-failed') || '';
        for (var k = 0; k < btns.length; k++) btns[k].disabled = false;
      });
      return;
    }
    var unhide = t.closest('[data-fy-unhide]');
    if (unhide) {
      unhide.disabled = true;
      post('/api/media/sources/' + encodeURIComponent(unhide.getAttribute('data-fy-unhide')) + '/hidden', { hidden: false })
        .then(function () {
          var span = document.createElement('span');
          span.className = 'fy-hint';
          span.setAttribute('role', 'status');
          span.textContent = root.getAttribute('data-fy-shown') || '';
          unhide.replaceWith(span);
        }, function () {
          unhide.disabled = false;
          unhide.textContent = root.getAttribute('data-fy-failed') || unhide.textContent;
        });
    }
  });

  // Each play button's words follow its audio: Pause while it plays, Play otherwise.
  function label(audio, which) {
    var btn = root.querySelector('[data-fy-play="' + audio.id + '"]');
    if (btn) btn.textContent = root.getAttribute('data-fy-' + which + '-label') || btn.textContent;
  }
  var audios = root.querySelectorAll('audio[id^="fy-audio-"]');
  for (var m = 0; m < audios.length; m++) {
    audios[m].addEventListener('play', function (e) {
      var el = e.currentTarget;
      label(el, 'pause');
      var played = el.getAttribute('data-fy-played');
      if (played && !el.__fyMarked) {
        el.__fyMarked = true;
        post('/api/media/articles/' + encodeURIComponent(played) + '/action', { action: 'mark_read' }, true).catch(function () {});
      }
    });
    audios[m].addEventListener('pause', function (e) { label(e.currentTarget, 'play'); });
    audios[m].addEventListener('ended', function (e) { label(e.currentTarget, 'play'); });
  }

  // Focus returns to the story that opened the sheet; open sheets close before Turbo caches the page.
  var sheets = root.querySelectorAll('dialog.fy-sheet');
  for (var i = 0; i < sheets.length; i++) {
    sheets[i].addEventListener('close', function (e) {
      var o = e.currentTarget.__fyOpener;
      e.currentTarget.__fyOpener = null;
      if (o && document.contains(o) && typeof o.focus === 'function') o.focus();
    });
  }
  if (!window.__crowForYouCacheBound) {
    window.__crowForYouCacheBound = true;
    document.addEventListener('turbo:before-cache', function () {
      var open = document.querySelectorAll('dialog.fy-sheet[open]');
      for (var j = 0; j < open.length; j++) closeSheet(open[j]);
    });
  }
})();
</script>`;
}
