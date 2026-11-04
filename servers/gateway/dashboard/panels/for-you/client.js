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
 *   What needs me -> POST /dashboard/widgets-api/needs-me/act {key, action, nonce}, then the widget is
 *     repainted from the returned summary; a 409 (the item changed elsewhere) re-reads the summary
 *     and repaints that instead of retrying.
 *   A camera still (the camera widget) -> the same image URL with a fresh ?t=<now> on the end, so a
 *     tap asks Frigate for a newer frame. Never a video: the widget only ever shows one still.
 * Messages come from the page's data-fy-* attributes (server-translated).
 *
 * Emitted inside a template literal: this source must contain NO backticks. It re-runs on every
 * Turbo visit; the page is part of the swapped body, so listeners bind fresh each time. A widget
 * page may fetch a cell's markup after the page was drawn (widgets/grid-client.js), so the
 * per-element listeners live in `bindWidgetMarkup(scope)` and the page leaves it on
 * `window.crowBindWidgetMarkup` for that fill to call.
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
    var days = Number((json.streak || {}).days) || 0;
    put('[data-fy-move-streak]', tpl(days === 1 ? 'data-fy-streak-one-fmt' : 'data-fy-streak-other-fmt', days));
    var doneBtn = card.querySelector('[data-fy-move="done"]');
    if (doneBtn) {
      doneBtn.textContent = c.done
        ? (card.getAttribute('data-fy-done-state') || doneBtn.textContent)
        : (card.getAttribute('data-fy-done-label') || doneBtn.textContent);
      doneBtn.disabled = !!c.done;
      if (c.day) doneBtn.setAttribute('data-day', String(c.day));
    }
  }

  // 'What needs me': a button answers its item in place. The tap carries the nonce the row was
  // drawn with, so a change made on another device answers 409 stale and the widget re-reads the
  // summary instead of acting twice; any other failure is the page's own action-failed line.
  function needsText(value) {
    return String(value == null ? '' : value);
  }
  // One item row, rebuilt from the summary: text and attributes only, never markup.
  function needsRow(box, item) {
    var li = document.createElement('li');
    li.className = 'fy-needs-item';
    li.setAttribute('data-fy-needs-item', needsText(item.key));
    var a = document.createElement('a');
    a.className = 'fy-line';
    var href = needsText(item.href);
    a.setAttribute('href', href.charAt(0) === '/' && href.charAt(1) !== '/' ? href : '/dashboard/bot-board');
    var text = document.createElement('span');
    text.className = 'fy-line-text';
    var tag = box.getAttribute('data-fy-needs-kind-' + needsText(item.kind));
    if (tag) {
      var tagEl = document.createElement('span');
      tagEl.className = 'fy-line-tag';
      tagEl.textContent = tag;
      text.appendChild(tagEl);
    }
    var title = document.createElement('span');
    title.className = 'fy-line-title';
    title.textContent = needsText(item.title);
    if (item.project) {
      var proj = document.createElement('span');
      proj.className = 'fy-line-proj';
      proj.textContent = ' · ' + needsText(item.project);
      title.appendChild(proj);
    }
    text.appendChild(title);
    a.appendChild(text);
    li.appendChild(a);
    var actions = item.actions || [];
    if (actions.length) {
      var acts = document.createElement('div');
      acts.className = 'fy-acts fy-needs-acts';
      for (var i = 0; i < actions.length; i++) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = actions[i].style === 'primary' ? 'fy-btn fy-btn--primary' : 'fy-btn';
        b.textContent = needsText(actions[i].label);
        b.setAttribute('aria-label', needsText(actions[i].label) + ': ' + needsText(item.title));
        b.setAttribute('data-fy-needs-act', needsText(actions[i].id));
        b.setAttribute('data-fy-needs-key', needsText(item.key));
        b.setAttribute('data-fy-needs-nonce', needsText(item.nonce));
        acts.appendChild(b);
      }
      li.appendChild(acts);
    }
    return li;
  }
  function needsFill(list, rows) {
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    for (var i = 0; i < rows.length; i++) list.appendChild(rows[i]);
    if (rows.length) list.removeAttribute('hidden'); else list.setAttribute('hidden', '');
  }
  // Repaint the widget from a summary (the act's own answer, or a fresh read after a stale tap).
  function paintNeeds(box, summary) {
    if (!box || !summary || !Array.isArray(summary.items)) return false;
    var head = box.querySelector('[data-fy-needs-headline]');
    if (head) {
      head.textContent = summary.state === 'error'
        ? (box.getAttribute('data-fy-needs-error') || '')
        : needsText(summary.headline);
    }
    var items = summary.items || [];
    var rows = [];
    for (var i = 0; i < items.length; i++) rows.push(needsRow(box, items[i]));
    needsFill(box.querySelector('[data-fy-needs-list]'), rows);
    var doing = summary.doing || [];
    var dhead = box.querySelector('[data-fy-needs-doing-h]');
    if (dhead) {
      dhead.textContent = box.getAttribute('data-fy-needs-doing-label') || dhead.textContent;
      if (doing.length) dhead.removeAttribute('hidden'); else dhead.setAttribute('hidden', '');
    }
    var drows = [];
    for (var j = 0; j < doing.length; j++) {
      var line = document.createElement('li');
      line.className = 'fy-line-text';
      line.textContent = needsText(doing[j]);
      drows.push(line);
    }
    needsFill(box.querySelector('[data-fy-needs-doing]'), drows);
    return true;
  }
  // A JSON request whose status this code has to read: 409 is a refresh, never a retry.
  function needsFetch(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().then(function (json) {
        return { status: r.status, ok: r.ok, json: json };
      }, function () {
        return { status: r.status, ok: r.ok, json: null };
      });
    });
  }
  function needsAct(box, btn, status, btns) {
    var body = {
      key: btn.getAttribute('data-fy-needs-key') || '',
      action: btn.getAttribute('data-fy-needs-act') || '',
      nonce: btn.getAttribute('data-fy-needs-nonce') || ''
    };
    if (box.getAttribute('data-fy-needs-busy')) return;
    box.setAttribute('data-fy-needs-busy', '1');
    if (status) status.textContent = '';
    for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
    function done() { box.removeAttribute('data-fy-needs-busy'); }
    function failed() {
      if (status) status.textContent = root.getAttribute('data-fy-failed') || '';
      for (var k = 0; k < btns.length; k++) btns[k].disabled = false;
    }
    return needsFetch('/dashboard/widgets-api/needs-me/act', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-crow-csrf': csrf() },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (res.status === 409) {
        return needsFetch('/dashboard/widgets-api/needs-me', { credentials: 'same-origin' }).then(function (fresh) {
          if (!fresh.ok || !paintNeeds(box, fresh.json)) throw new Error('refresh failed');
        });
      }
      if (!res.ok || !res.json || !res.json.summary) throw new Error('act failed');
      if (!paintNeeds(box, res.json.summary)) throw new Error('act failed');
    }).catch(failed).then(done, done);
  }

  root.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    var need = t.closest('[data-fy-needs-act]');
    if (need) {
      var box = need.closest('[data-fy-needs]');
      if (box) needsAct(box, need, box.querySelector('[data-fy-needs-status]'), box.querySelectorAll('[data-fy-needs-act]'));
      return;
    }
    // A camera still: a tap reloads that image and leaves the rest of the grid alone.
    var cam = t.closest('[data-wg-cam]');
    if (cam) {
      var camImg = cam.querySelector('img');
      var camSrc = camImg ? String(camImg.getAttribute('src') || '').split('?')[0] : '';
      if (camSrc) camImg.setAttribute('src', camSrc + '?t=' + String(Date.now()));
      return;
    }
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
        })
        .catch(function () {
          // Painting threw after a successful save: the buttons must not stay stuck disabled.
          if (mstatus) mstatus.textContent = root.getAttribute('data-fy-failed') || '';
          for (var mz = 0; mz < mbtns.length; mz++) mbtns[mz].disabled = false;
        });
      return;
    }
  });

  // Each play button's words follow its audio: Pause while it plays, Play otherwise.
  function label(audio, which) {
    var btn = root.querySelector('[data-fy-play="' + audio.id + '"]');
    if (btn) btn.textContent = root.getAttribute('data-fy-' + which + '-label') || btn.textContent;
  }
  // The per-element listeners, over one scope: a tile's audio labels its Play button, and a sheet's
  // close returns focus to the story that opened it. A widget page may fetch a cell long after the
  // page was drawn (widgets/grid-client.js), so this runs again over the fetched body and marks what
  // it bound: nothing binds twice.
  function bindWidgetMarkup(scope) {
    var box = scope || root;
    if (!box || !box.querySelectorAll) return;
    var audios = box.querySelectorAll('audio[id^="fy-audio-"]');
    for (var m = 0; m < audios.length; m++) {
      if (audios[m].getAttribute('data-fy-bound') === 'audio') continue;
      audios[m].setAttribute('data-fy-bound', 'audio');
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
    var sheets = box.querySelectorAll('dialog.fy-sheet');
    for (var i = 0; i < sheets.length; i++) {
      if (sheets[i].getAttribute('data-fy-bound') === 'sheet') continue;
      sheets[i].setAttribute('data-fy-bound', 'sheet');
      sheets[i].addEventListener('close', function (e) {
        var o = e.currentTarget.__fyOpener;
        e.currentTarget.__fyOpener = null;
        if (o && document.contains(o) && typeof o.focus === 'function') o.focus();
      });
    }
  }
  // The page as the server drew it, and the hook a lazy cell's fill calls for markup it fetched.
  bindWidgetMarkup(root);
  if (typeof window.crowBindWidgetMarkup !== 'function') window.crowBindWidgetMarkup = bindWidgetMarkup;

  // Open sheets close before Turbo caches the page. The snapshot keeps attributes, not listeners, so
  // the binding markers come off too: a restored page binds its sheets and audio again.
  if (!window.__crowForYouCacheBound) {
    window.__crowForYouCacheBound = true;
    document.addEventListener('turbo:before-cache', function () {
      var open = document.querySelectorAll('dialog.fy-sheet[open]');
      for (var j = 0; j < open.length; j++) closeSheet(open[j]);
      var marked = root.querySelectorAll('[data-fy-bound]');
      for (var k = 0; k < marked.length; k++) marked[k].removeAttribute('data-fy-bound');
    });
  }
})();
</script>`;
}
