/**
 * For You's client JS (For You v1): opens a story's sheet, and sends its buttons to Media Hub's
 * own API (same origin, the session cookie, the CSRF header):
 *   More like this  -> POST /api/media/articles/:id/action {action:"thumbs_up"}
 *   Less like this  -> ... {action:"thumbs_down"}, and the story leaves the list
 *   Hide <source>   -> POST /api/media/sources/:id/hidden {hidden:true}, its stories leave the list
 *   Read at <source> -> ... {action:"mark_read"} (fire and forget), so a read story isn't picked again
 *   Show again (customize) -> POST /api/media/sources/:id/hidden {hidden:false}
 *   Done / Swap (Move) -> POST /api/ramble/moves/done {day} and /api/ramble/moves/swap, then the
 *     card is repainted from the JSON those routes return (textContent only, never HTML).
 *   Play (Listen) -> the shared player bar (window.crowPlayer.load; a briefing with ready shows is queued
 *     with them, crowPlayer.queue), as Media Hub plays; without the bar,
 *     the tile's own <audio> element (Play / Pause, one at a time). A podcast episode that starts
 *     playing is marked read ({action:"mark_read"}), so it leaves the list.
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

  // Ramble's Move card: repaint its text from the JSON a Done or a Swap returned. Only
  // textContent (and the bar's width) is written, so nothing from the bundle can become markup.
  function paintMoves(card, json) {
    var c = json && json.challenge;
    if (!card || !c) return;
    var entry = c.entry || {};
    function put(sel, text) {
      var el = card.querySelector(sel);
      if (el) el.textContent = text;
    }
    function tpl(attr, n) {
      return String(card.getAttribute(attr) || '{n}').replace('{n}', String(n));
    }
    put('[data-fy-move-title]', entry.title || '');
    put('[data-fy-move-minutes]', entry.minutes ? tpl('data-fy-minutes-fmt', entry.minutes) : '');
    put('[data-fy-move-why]', c.why || '');
    var why = card.querySelector('[data-fy-move-why]');
    if (why) {
      if (c.why) why.removeAttribute('hidden');
      else why.setAttribute('hidden', '');
    }
    var health = json.health || {};
    var energy = Number(health.energy) || 0;
    var max = Number(health.max) || 0;
    var healthText = tpl('data-fy-health-fmt', energy).replace('{max}', String(max));
    put('[data-fy-move-energy]', healthText);
    var bar = card.querySelector('[data-fy-move-energy-bar]');
    if (bar) {
      bar.style.width = (max > 0 ? Math.max(0, Math.min(100, Math.round((energy / max) * 100))) : 0) + '%';
      if (bar.parentNode && bar.parentNode.setAttribute) bar.parentNode.setAttribute('aria-label', healthText);
    }
    var steps = json.steps || {};
    put('[data-fy-move-steps]', tpl('data-fy-steps-fmt', Number(steps.steps) || 0).replace('{goal}', String(Number(steps.goal) || 0)));
    put('[data-fy-move-streak]', tpl('data-fy-streak-fmt', Number((json.streak || {}).days) || 0));
    var doneBtn = card.querySelector('[data-fy-move="done"]');
    if (doneBtn) {
      doneBtn.textContent = c.done
        ? (card.getAttribute('data-fy-done-state') || doneBtn.textContent)
        : (card.getAttribute('data-fy-done-label') || doneBtn.textContent);
      doneBtn.disabled = !!c.done;
      if (c.day) doneBtn.setAttribute('data-day', String(c.day));
    }
  }

  root.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    var play = t.closest('[data-fy-play]');
    if (play) {
      var audio = document.getElementById(play.getAttribute('data-fy-play'));
      if (!audio) return;
      var all = root.querySelectorAll('audio');
      // The shared player bar plays it, as Media Hub does: it keeps playing in the background and on the lock
      // screen, and a bare inline element stayed silent in the Android app. The inline element is the fallback.
      var bar = window.crowPlayer;
      if (bar && typeof bar.load === 'function') {
        for (var q = 0; q < all.length; q++) if (!all[q].paused) all[q].pause();
        var named = document.getElementById(play.getAttribute('aria-describedby') || '');
        var first = { src: audio.getAttribute('src'), title: named ? named.textContent.trim() : '', subtitle: '' };
        // A briefing's shows (Democracy Now!, ...) follow it, as Media Hub's own Play queues them.
        var then = root.querySelectorAll('[data-fy-then="' + audio.id + '"]');
        if (then.length && typeof bar.queue === 'function') {
          var items = [first];
          for (var s = 0; s < then.length; s++) items.push({ src: then[s].getAttribute('data-src'), title: then[s].getAttribute('data-title') || '', subtitle: then[s].getAttribute('data-sub') || '' });
          bar.queue(items);
        } else {
          bar.load(first.src, first.title, first.subtitle);
        }
        var playedId = audio.getAttribute('data-fy-played');
        if (playedId && !audio.__fyMarked) {
          audio.__fyMarked = true;
          post('/api/media/articles/' + encodeURIComponent(playedId) + '/action', { action: 'mark_read' }, true).catch(function () {});
        }
        return;
      }
      if (!audio.paused) { audio.pause(); return; }
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
      return;
    }
    var mv = t.closest('[data-fy-move]');
    if (mv) {
      var mcard = mv.closest('[data-fy-move-card]');
      if (!mcard) return;
      var mverb = mv.getAttribute('data-fy-move');
      var mstatus = mcard.querySelector('[data-fy-move-status]');
      var mbtns = mcard.querySelectorAll('[data-fy-move]');
      for (var mi = 0; mi < mbtns.length; mi++) mbtns[mi].disabled = true;
      post('/api/ramble/moves/' + (mverb === 'done' ? 'done' : 'swap'),
        mverb === 'done' ? { day: mv.getAttribute('data-day') || '' } : {})
        .then(function (r) { return r.json(); })
        .then(function (json) {
          paintMoves(mcard, json);
          if (mstatus) mstatus.textContent = json && json.refused ? (mcard.getAttribute('data-fy-refused') || '') : '';
          for (var mj = 0; mj < mbtns.length; mj++) {
            var isDone = mbtns[mj].getAttribute('data-fy-move') === 'done' && json && json.challenge && json.challenge.done;
            mbtns[mj].disabled = !!isDone;
          }
        }, function () {
          if (mstatus) mstatus.textContent = root.getAttribute('data-fy-failed') || '';
          for (var mk = 0; mk < mbtns.length; mk++) mbtns[mk].disabled = false;
        });
      return;
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
