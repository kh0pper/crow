/**
 * Persistent Player Bar — Global audio player for the Crow's Nest.
 *
 * Provides a fixed bottom bar with play/pause, seek, queue, next/prev,
 * and localStorage persistence. Any panel (media, podcasts, etc.) can
 * use `window.crowPlayer` to play audio.
 *
 * Exports:
 *   playerBarHtml(lang)  — HTML string for the bar (hidden by default)
 *   playerBarJs(lang)    — Inline JS string for the crowPlayer API
 */

import { t, tJs } from "./i18n.js";

export function playerBarHtml(lang) {
  return `<div id="crow-player-bar" style="display:none;position:fixed;bottom:0;left:240px;right:0;background:var(--crow-bg-surface);border-top:2px solid var(--crow-accent);z-index:1000;padding:0;transition:left 0.2s">
  <div style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 1rem">
    <button id="crow-player-prev" onclick="window.crowPlayer.prev()" title="${t("player.previous", lang)}" style="background:none;border:none;color:var(--crow-text-muted);cursor:pointer;font-size:0.9rem;padding:0.2rem;display:none">&#9198;</button>
    <button id="crow-player-toggle" onclick="window.crowPlayer.toggle()" title="${t("player.playPause", lang)}" style="background:var(--crow-accent);color:white;border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;font-size:1rem;display:flex;align-items:center;justify-content:center;flex-shrink:0">&#9654;</button>
    <button id="crow-player-next" onclick="window.crowPlayer.next()" title="${t("player.next", lang)}" style="background:none;border:none;color:var(--crow-text-muted);cursor:pointer;font-size:0.9rem;padding:0.2rem;display:none">&#9197;</button>
    <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
      <div style="display:flex;align-items:center;gap:0.5rem">
        <div id="crow-player-title" style="font-size:0.8rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0"></div>
        <span id="crow-player-time" style="font-size:0.7rem;color:var(--crow-text-muted);font-family:'JetBrains Mono',monospace;flex-shrink:0"></span>
      </div>
      <div id="crow-player-subtitle" style="font-size:0.7rem;color:var(--crow-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none"></div>
      <div id="crow-player-seek-wrap" style="position:relative;height:6px;background:var(--crow-bg-elevated);border-radius:3px;cursor:pointer" onclick="window.crowPlayer._seek(event)">
        <div id="crow-player-progress" style="height:100%;background:var(--crow-accent);border-radius:3px;width:0%;transition:width 0.1s linear"></div>
      </div>
    </div>
    <button onclick="window.crowPlayer.close()" title="${t("player.close", lang)}" style="background:none;border:none;color:var(--crow-text-muted);cursor:pointer;font-size:1.2rem;flex-shrink:0;padding:0.2rem">&times;</button>
  </div>
  <audio id="crow-audio" preload="none"></audio>
</div>`;
}

export function playerBarJs(lang) {
  return `
(function() {
  var audio = document.getElementById('crow-audio');
  var bar = document.getElementById('crow-player-bar');
  var titleEl = document.getElementById('crow-player-title');
  var subtitleEl = document.getElementById('crow-player-subtitle');
  var timeEl = document.getElementById('crow-player-time');
  var progressEl = document.getElementById('crow-player-progress');
  var toggleBtn = document.getElementById('crow-player-toggle');
  var prevBtn = document.getElementById('crow-player-prev');
  var nextBtn = document.getElementById('crow-player-next');
  var seekWrap = document.getElementById('crow-player-seek-wrap');

  var PLAY_ICON = '\\u25B6';
  var PAUSE_ICON = '\\u23F8';
  var PLAYING_LABEL = '${tJs("player.playing", lang)}';
  var PAUSED_LABEL = '${tJs("player.paused", lang)}';

  var queue = [];
  var queueIndex = -1;
  var saveTimer = null;
  var STORAGE_KEY = 'crow-player-state';

  function fmt(s) {
    if (!s || !isFinite(s)) return '0:00';
    var m = Math.floor(s / 60);
    var sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function updateTime() {
    if (!audio.duration) { timeEl.textContent = ''; return; }
    timeEl.textContent = fmt(audio.currentTime) + ' / ' + fmt(audio.duration);
    var pct = (audio.currentTime / audio.duration) * 100;
    progressEl.style.width = pct + '%';
  }

  function updateToggleIcon() {
    toggleBtn.textContent = audio.paused ? PLAY_ICON : PAUSE_ICON;
  }

  function updateNavButtons() {
    var show = queue.length > 1;
    prevBtn.style.display = show ? 'block' : 'none';
    nextBtn.style.display = show ? 'block' : 'none';
  }

  function throttledSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function() {
      saveTimer = null;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          src: audio.src,
          title: titleEl.textContent,
          subtitle: subtitleEl.textContent,
          time: audio.currentTime,
          queue: queue,
          queueIndex: queueIndex
        }));
      } catch(e) {}
    }, 5000);
  }

  audio.addEventListener('timeupdate', function() { updateTime(); throttledSave(); });
  audio.addEventListener('play', updateToggleIcon);
  audio.addEventListener('pause', updateToggleIcon);
  audio.addEventListener('ended', function() {
    if (queueIndex < queue.length - 1) {
      window.crowPlayer.next();
    } else {
      updateToggleIcon();
    }
  });

  function adjustPosition() {
    bar.style.left = (window.innerWidth <= 768) ? '0' : '240px';
  }
  window.addEventListener('resize', adjustPosition);

  function playItem(item) {
    bar.style.display = 'block';
    adjustPosition();
    titleEl.textContent = item.title || PLAYING_LABEL;
    if (item.subtitle) {
      subtitleEl.textContent = item.subtitle;
      subtitleEl.style.display = 'block';
    } else {
      subtitleEl.style.display = 'none';
    }
    audio.src = item.src;
    audio.play().catch(function() {});
    progressEl.style.width = '0%';
    updateNavButtons();
    throttledSave();
  }

  window.crowPlayer = {
    load: function(src, title, subtitle) {
      var item = { src: src, title: title, subtitle: subtitle };
      if (queue.length === 0 || !queue[queueIndex] || queue[queueIndex].src !== src) {
        queue = [item];
        queueIndex = 0;
      }
      playItem(item);
    },

    queue: function(items) {
      if (!items || items.length === 0) return;
      queue = items.map(function(i) { return { src: i.src, title: i.title, subtitle: i.subtitle }; });
      queueIndex = 0;
      playItem(queue[0]);
    },

    addToQueue: function(item) {
      queue.push({ src: item.src, title: item.title, subtitle: item.subtitle });
      if (queue.length === 1) {
        queueIndex = 0;
        playItem(queue[0]);
      }
      updateNavButtons();
    },

    next: function() {
      if (queueIndex < queue.length - 1) {
        queueIndex++;
        playItem(queue[queueIndex]);
      }
    },

    prev: function() {
      if (audio.currentTime > 3 || queueIndex === 0) {
        audio.currentTime = 0;
        audio.play().catch(function() {});
        return;
      }
      queueIndex--;
      playItem(queue[queueIndex]);
    },

    toggle: function() {
      if (audio.paused) audio.play().catch(function() {}); else audio.pause();
    },

    isPlaying: function() {
      return !audio.paused;
    },

    close: function() {
      audio.pause();
      audio.src = '';
      bar.style.display = 'none';
      queue = [];
      queueIndex = -1;
      try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
    },

    _seek: function(e) {
      if (!audio.duration) return;
      var rect = seekWrap.getBoundingClientRect();
      var pct = (e.clientX - rect.left) / rect.width;
      audio.currentTime = pct * audio.duration;
    },

    getQueue: function() { return queue.slice(); },
    getQueueIndex: function() { return queueIndex; }
  };

  // Restore state from localStorage
  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && saved.src) {
      bar.style.display = 'block';
      adjustPosition();
      titleEl.textContent = saved.title || PAUSED_LABEL;
      if (saved.subtitle) {
        subtitleEl.textContent = saved.subtitle;
        subtitleEl.style.display = 'block';
      }
      audio.src = saved.src;
      if (saved.time) {
        audio.addEventListener('loadedmetadata', function onMeta() {
          audio.currentTime = saved.time;
          audio.removeEventListener('loadedmetadata', onMeta);
        });
      }
      if (saved.queue) { queue = saved.queue; queueIndex = saved.queueIndex || 0; }
      updateNavButtons();
    }
  } catch(e) {}
})();
`;
}
