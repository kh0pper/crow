/**
 * Persistent Player Bar — Global audio player for the Crow's Nest.
 *
 * Provides a fixed bottom bar with play/pause, seek, queue, next/prev, stop,
 * and localStorage persistence. Any panel can use `window.crowPlayer` to play.
 *
 * Supports two backends:
 *   - "local": HTML5 <audio> element (podcasts, media briefings, Funkwhale proxy, etc.)
 *   - "glasses": Meta-glasses device audio via REST control endpoints
 *
 * Exports:
 *   playerBarHtml(lang)  — HTML string for the bar (hidden by default)
 *   playerBarJs(lang)    — Inline JS string for the crowPlayer API
 */

import { t, tJs } from "./i18n.js";

export function playerBarHtml(lang) {
  return `<style>@media(max-width:768px){#crow-player-bar{left:0!important}}</style>
<div id="crow-player-bar" data-turbo-permanent style="display:none;position:fixed;bottom:0;left:240px;right:0;background:var(--crow-bg-surface);border-top:2px solid var(--crow-accent);z-index:1000;padding:0;transition:left 0.2s">
  <div style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 1rem">
    <button id="crow-player-prev" onclick="window.crowPlayer.prev()" title="${t("player.previous", lang)}" style="background:none;border:none;color:var(--crow-text-muted);cursor:pointer;font-size:0.9rem;padding:0.2rem;display:none">&#9198;</button>
    <button id="crow-player-toggle" onclick="window.crowPlayer.toggle()" title="${t("player.playPause", lang)}" style="background:var(--crow-accent);color:white;border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;font-size:1rem;display:flex;align-items:center;justify-content:center;flex-shrink:0">&#9654;</button>
    <button id="crow-player-next" onclick="window.crowPlayer.next()" title="${t("player.next", lang)}" style="background:none;border:none;color:var(--crow-text-muted);cursor:pointer;font-size:0.9rem;padding:0.2rem;display:none">&#9197;</button>
    <button id="crow-player-stop" onclick="window.crowPlayer.stop()" title="${t("player.stop", lang)}" style="background:none;border:none;color:var(--crow-text-muted);cursor:pointer;font-size:0.9rem;padding:0.2rem;display:none">&#9632;</button>
    <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
      <div style="display:flex;align-items:center;gap:0.5rem">
        <div id="crow-player-title" style="font-size:0.8rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0"></div>
        <span id="crow-player-source" style="font-size:0.6rem;color:var(--crow-text-muted);background:var(--crow-bg-elevated);padding:0.05rem 0.35rem;border-radius:3px;display:none;flex-shrink:0"></span>
        <span id="crow-player-time" style="font-size:0.7rem;color:var(--crow-text-muted);font-family:'JetBrains Mono',monospace;flex-shrink:0"></span>
      </div>
      <div id="crow-player-subtitle" style="font-size:0.7rem;color:var(--crow-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none"></div>
      <div id="crow-player-seek-wrap" style="position:relative;height:6px;background:var(--crow-bg-elevated);border-radius:3px;cursor:pointer" onclick="window.crowPlayer._seek(event)">
        <div id="crow-player-progress" style="height:100%;background:var(--crow-accent);border-radius:3px;width:0%;transition:width 0.1s linear"></div>
      </div>
    </div>
    <button onclick="window.crowPlayer.close()" title="${t("player.close", lang)}" style="background:none;border:none;color:var(--crow-text-muted);cursor:pointer;font-size:1.2rem;flex-shrink:0;padding:0.2rem">&times;</button>
  </div>
  <audio id="crow-audio" data-turbo-permanent preload="none"></audio>
</div>`;
}

export function playerBarJs(lang) {
  return `
(function() {
  var audio = document.getElementById('crow-audio');
  // Early-return if this page has no player bar (non-dashboard layouts).
  if (!audio) return;
  // Under Turbo Drive, this IIFE re-executes on every nav, but the audio
  // element is data-turbo-permanent. Check the dataset flag to avoid
  // re-attaching listeners to the same persistent element.
  if (audio.dataset.crowPlayerInitialized === '1') return;
  audio.dataset.crowPlayerInitialized = '1';
  var bar = document.getElementById('crow-player-bar');
  var titleEl = document.getElementById('crow-player-title');
  var subtitleEl = document.getElementById('crow-player-subtitle');
  var timeEl = document.getElementById('crow-player-time');
  var progressEl = document.getElementById('crow-player-progress');
  var toggleBtn = document.getElementById('crow-player-toggle');
  var prevBtn = document.getElementById('crow-player-prev');
  var nextBtn = document.getElementById('crow-player-next');
  var stopBtn = document.getElementById('crow-player-stop');
  var sourceEl = document.getElementById('crow-player-source');
  var seekWrap = document.getElementById('crow-player-seek-wrap');

  var PLAY_ICON = '\\u25B6';
  var PAUSE_ICON = '\\u23F8';
  var PLAYING_LABEL = '${tJs("player.playing", lang)}';
  var PAUSED_LABEL = '${tJs("player.paused", lang)}';
  var SOURCE_GLASSES = '${tJs("player.sourceGlasses", lang)}';

  var queue = [];
  var queueIndex = -1;
  var saveTimer = null;
  var STORAGE_KEY = 'crow-player-state';
  var currentMetadata = null;
  var closedByUser = false;

  // --- Backend state ---
  var activeBackend = 'local'; // 'local' | 'glasses'
  var glassesDeviceId = null;
  var glassesState = 'idle'; // 'idle' | 'playing' | 'paused'
  var glassesTitle = '';
  var glassesArtist = '';
  var glassesPollTimer = null;
  var glassesDeviceProbeTimer = null;
  var glassesBundleAvailable = null; // null = unknown, true/false after probe
  var glassesPending = false; // true during restore-from-localStorage until first poll

  function fmt(s) {
    if (!s || !isFinite(s)) return '0:00';
    var m = Math.floor(s / 60);
    var sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function updateTime() {
    if (activeBackend !== 'local') { timeEl.textContent = ''; return; }
    if (!audio.duration) { timeEl.textContent = ''; return; }
    timeEl.textContent = fmt(audio.currentTime) + ' / ' + fmt(audio.duration);
    var pct = (audio.currentTime / audio.duration) * 100;
    progressEl.style.width = pct + '%';
  }

  function updateToggleIcon() {
    if (activeBackend === 'glasses') {
      toggleBtn.textContent = glassesState === 'paused' ? PLAY_ICON : PAUSE_ICON;
    } else {
      toggleBtn.textContent = audio.paused ? PLAY_ICON : PAUSE_ICON;
    }
  }

  function updateNavButtons() {
    if (activeBackend === 'glasses') {
      prevBtn.style.display = 'none';
      nextBtn.style.display = 'block';
      stopBtn.style.display = 'block';
      seekWrap.style.display = 'none';
      timeEl.style.display = 'none';
      sourceEl.textContent = SOURCE_GLASSES;
      sourceEl.style.display = 'inline';
    } else {
      var show = queue.length > 1;
      prevBtn.style.display = show ? 'block' : 'none';
      nextBtn.style.display = show ? 'block' : 'none';
      stopBtn.style.display = 'none';
      seekWrap.style.display = 'block';
      timeEl.style.display = '';
      sourceEl.style.display = 'none';
    }
  }

  function setPending(on) {
    glassesPending = on;
    bar.style.opacity = on ? '0.5' : '1';
    toggleBtn.disabled = on;
    if (stopBtn) stopBtn.disabled = on;
    if (nextBtn) nextBtn.disabled = on;
  }

  function saveState() {
    if (closedByUser) return;
    if (bar.style.display === 'none') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        backend: activeBackend,
        src: audio.src,
        title: titleEl.textContent,
        subtitle: subtitleEl.textContent,
        time: audio.currentTime,
        wasPlaying: !audio.paused && !!audio.src,
        queue: queue,
        queueIndex: queueIndex,
        metadata: currentMetadata,
        glassesDeviceId: glassesDeviceId,
        glassesTitle: glassesTitle,
        glassesArtist: glassesArtist,
      }));
    } catch(e) {}
  }
  function throttledSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function() {
      saveTimer = null;
      saveState();
    }, 5000);
  }

  audio.addEventListener('timeupdate', function() { updateTime(); throttledSave(); });
  audio.addEventListener('play', function() { updateToggleIcon(); saveState(); });
  audio.addEventListener('pause', function() { updateToggleIcon(); saveState(); });
  // Save immediately on navigation — pagehide fires for tab close + cross-origin nav.
  window.addEventListener('pagehide', function() { saveState(); });
  // Under Turbo Drive, in-document nav fires turbo:before-visit instead of pagehide.
  // Save state there too so audio position persists across client-side nav.
  document.addEventListener('turbo:before-visit', function() { saveState(); });

  // Cleanup: if the next page's response does NOT contain #crow-player-bar,
  // Turbo will discard the permanent element. Before that happens, save state
  // and remove our document-level listeners so they don't leak into the next
  // document.
  document.addEventListener('turbo:before-render', function(ev) {
    try {
      var newBody = ev.detail && ev.detail.newBody;
      if (newBody && !newBody.querySelector('#crow-player-bar')) {
        saveState();
        // Listeners will naturally disappear when the closure is GC'd
        // after the permanent element is evicted.
      }
    } catch (e) {}
  });
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

  function switchToLocal() {
    if (activeBackend === 'glasses') {
      activeBackend = 'local';
      updateNavButtons();
    }
  }

  function playItem(item) {
    closedByUser = false;
    switchToLocal();
    bar.style.display = 'block';
    setPending(false);
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
    applyMediaSessionMetadata(item.metadata || { title: item.title, artist: item.subtitle });
    throttledSave();
  }

  // --- Autoplay-blocked resume overlay (Chrome autoplay policy) ---
  function showResumeOverlay() {
    // Make the play button pulse to indicate the user should tap it to resume.
    try {
      toggleBtn.style.animation = 'crow-pulse 1.2s infinite';
      toggleBtn.style.boxShadow = '0 0 0 3px rgba(127, 200, 255, 0.5)';
      // Inject the keyframes once.
      if (!document.getElementById('crow-player-pulse-kf')) {
        var st = document.createElement('style');
        st.id = 'crow-player-pulse-kf';
        st.textContent = '@keyframes crow-pulse { 0% { transform: scale(1); } 50% { transform: scale(1.12); } 100% { transform: scale(1); } }';
        document.head.appendChild(st);
      }
      var clear = function() {
        toggleBtn.style.animation = '';
        toggleBtn.style.boxShadow = '';
        audio.removeEventListener('play', clear);
      };
      audio.addEventListener('play', clear);
    } catch (e) {}
  }

  // --- navigator.mediaSession (Android shade/lockscreen controls) ---
  function applyMediaSessionMetadata(meta) {
    currentMetadata = meta || null;
    if (!('mediaSession' in navigator) || !meta) return;
    var art = [];
    if (meta.artwork) {
      // Route through dashboard-auth'd proxy (same origin, caches per-user)
      art.push({ src: '/api/funkwhale/artwork?src=' + encodeURIComponent(meta.artwork), sizes: '512x512' });
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.title || '',
        artist: meta.artist || '',
        album: meta.album || '',
        artwork: art,
      });
    } catch (e) {}
  }

  // --- Glasses backend helpers ---

  function glassesControl(action) {
    if (!glassesDeviceId) return Promise.resolve();
    return fetch('/api/meta-glasses/media/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ device_id: glassesDeviceId, action: action })
    }).catch(function() {
      // On failure, force a poll to re-sync state
      pollGlassesStatus();
    });
  }

  function showGlassesBar(title, artist, state) {
    closedByUser = false;
    activeBackend = 'glasses';
    glassesTitle = title || '';
    glassesArtist = artist || '';
    glassesState = state;
    bar.style.display = 'block';
    setPending(false);
    adjustPosition();
    titleEl.textContent = title || PLAYING_LABEL;
    if (artist) {
      subtitleEl.textContent = artist;
      subtitleEl.style.display = 'block';
    } else {
      subtitleEl.style.display = 'none';
    }
    updateNavButtons();
    updateToggleIcon();
    throttledSave();
  }

  function hideGlassesBar() {
    if (activeBackend !== 'glasses') return;
    glassesState = 'idle';
    glassesTitle = '';
    glassesArtist = '';
    bar.style.display = 'none';
    try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
  }

  // --- Glasses polling ---

  function pollGlassesStatus() {
    if (!glassesDeviceId) return;
    // Multi-tab coordination: check if another tab polled recently
    try {
      var lastPoll = parseInt(localStorage.getItem('crow-player-poll-ts') || '0', 10);
      if (Date.now() - lastPoll < 8000 && !glassesPending) {
        // Read cached result instead of polling
        var cached = localStorage.getItem('crow-player-poll-result');
        if (cached) {
          try { handleGlassesPollResult(JSON.parse(cached)); } catch(e) {}
        }
        return;
      }
    } catch(e) {}

    fetch('/api/meta-glasses/media/status?device_id=' + encodeURIComponent(glassesDeviceId), { credentials: 'same-origin' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        try {
          localStorage.setItem('crow-player-poll-ts', String(Date.now()));
          localStorage.setItem('crow-player-poll-result', JSON.stringify(data));
        } catch(e) {}
        handleGlassesPollResult(data);
      })
      .catch(function() {});
  }

  function handleGlassesPollResult(data) {
    if (!data) return;
    var newState = data.state || 'idle';

    if (newState === 'idle') {
      if (activeBackend === 'glasses' || glassesPending) {
        hideGlassesBar();
        setPending(false);
      }
      return;
    }

    // glasses are playing or paused
    if (activeBackend === 'local' && !audio.paused && audio.src) {
      // Local audio is actively playing — don't steal the bar
      return;
    }

    // Show or update the glasses bar
    showGlassesBar(data.title, data.artist, newState);
  }

  function probeGlassesDevices() {
    fetch('/api/meta-glasses/devices', { credentials: 'same-origin' })
      .then(function(r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function(data) {
        glassesBundleAvailable = true;
        var devs = data.devices || [];
        if (devs.length > 0) {
          glassesDeviceId = devs[0].id;
          startGlassesPoll();
        } else {
          glassesDeviceId = null;
          stopGlassesPoll();
        }
      })
      .catch(function() {
        glassesBundleAvailable = false;
      });
  }

  function startGlassesPoll() {
    if (glassesPollTimer) return;
    pollGlassesStatus(); // immediate first poll
    // Live updates stream over EventSource (see below). This 5-min
    // poll is a fallback-only safety net for transient SSE drops.
    // Pre-Streams it was 10s.
    glassesPollTimer = setInterval(pollGlassesStatus, 300000);
    startGlassesStream();
  }

  function stopGlassesPoll() {
    if (glassesPollTimer) { clearInterval(glassesPollTimer); glassesPollTimer = null; }
    stopGlassesStream();
  }

  // --- Live glasses media state via SSE (/dashboard/streams/glasses) ---
  // Server emits JSON matching /api/meta-glasses/media/status, so the
  // client pipes it through handleGlassesPollResult() just like a poll
  // response. We use a plain EventSource because player-bar state is
  // too stateful for a simple turbo-stream HTML swap.
  function startGlassesStream() {
    if (!glassesDeviceId) return;
    if (window.__crowGlassesStream) return; // one per tab
    try {
      var es = new EventSource('/dashboard/streams/glasses');
      window.__crowGlassesStream = es;
      es.addEventListener('media', function(evt) {
        try {
          var data = JSON.parse(evt.data);
          if (!data) return;
          // Filter: ignore events for other devices if multiple are paired.
          if (glassesDeviceId && data.device_id && data.device_id !== glassesDeviceId) return;
          handleGlassesPollResult(data);
        } catch (e) {}
      });
      es.addEventListener('session-expired', function() {
        try { es.close(); } catch(e) {}
        window.__crowGlassesStream = null;
        // Next fallback poll will hit /api/meta-glasses/media/status
        // and re-auth via the usual cookie path.
      });
      es.onerror = function() {
        // EventSource auto-reconnects; swallow to avoid noisy console logs.
      };
    } catch (e) {
      // No EventSource support or network error; fallback poll covers us.
    }
  }
  function stopGlassesStream() {
    if (window.__crowGlassesStream) {
      try { window.__crowGlassesStream.close(); } catch(e) {}
      window.__crowGlassesStream = null;
    }
  }

  // Visibility-based polling: poll immediately when tab becomes visible, pause when hidden
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) return;
    if (glassesPollTimer && glassesDeviceId) pollGlassesStatus();
  });

  // --- Public API ---

  window.crowPlayer = {
    load: function(src, title, subtitle, metadata) {
      var item = { src: src, title: title, subtitle: subtitle, metadata: metadata };
      if (queue.length === 0 || !queue[queueIndex] || queue[queueIndex].src !== src) {
        queue = [item];
        queueIndex = 0;
      }
      playItem(item);
    },

    queue: function(items) {
      if (!items || items.length === 0) return;
      switchToLocal();
      queue = items.map(function(i) { return { src: i.src, title: i.title, subtitle: i.subtitle, metadata: i.metadata }; });
      queueIndex = 0;
      playItem(queue[0]);
    },

    addToQueue: function(item) {
      switchToLocal();
      queue.push({ src: item.src, title: item.title, subtitle: item.subtitle, metadata: item.metadata });
      if (queue.length === 1) {
        queueIndex = 0;
        playItem(queue[0]);
      }
      updateNavButtons();
    },

    next: function() {
      if (activeBackend === 'glasses') {
        glassesControl('next');
        return;
      }
      if (queueIndex < queue.length - 1) {
        queueIndex++;
        playItem(queue[queueIndex]);
      }
    },

    prev: function() {
      if (activeBackend === 'glasses') return; // no prev for glasses
      if (audio.currentTime > 3 || queueIndex === 0) {
        audio.currentTime = 0;
        audio.play().catch(function() {});
        return;
      }
      queueIndex--;
      playItem(queue[queueIndex]);
    },

    toggle: function() {
      if (activeBackend === 'glasses') {
        var action = glassesState === 'paused' ? 'resume' : 'pause';
        glassesState = (action === 'pause') ? 'paused' : 'playing';
        updateToggleIcon();
        glassesControl(action);
        return;
      }
      if (audio.paused) audio.play().catch(function() {}); else audio.pause();
    },

    stop: function() {
      closedByUser = true;
      if (activeBackend === 'glasses') {
        glassesControl('stop');
        hideGlassesBar();
        return;
      }
      audio.pause();
      audio.src = '';
      bar.style.display = 'none';
      queue = [];
      queueIndex = -1;
      try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
    },

    isPlaying: function() {
      if (activeBackend === 'glasses') return glassesState === 'playing';
      return !audio.paused;
    },

    close: function() {
      closedByUser = true;
      if (activeBackend === 'glasses') {
        glassesControl('stop');
        hideGlassesBar();
        return;
      }
      audio.pause();
      audio.src = '';
      bar.style.display = 'none';
      queue = [];
      queueIndex = -1;
      try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
    },

    _seek: function(e) {
      if (activeBackend === 'glasses') return; // no seek for glasses
      if (!audio.duration) return;
      var rect = seekWrap.getBoundingClientRect();
      var pct = (e.clientX - rect.left) / rect.width;
      audio.currentTime = pct * audio.duration;
    },

    getQueue: function() { return queue.slice(); },
    getQueueIndex: function() { return queueIndex; },

    // --- Backend API ---
    setBackend: function(type, config) {
      activeBackend = type;
      if (type === 'glasses' && config && config.deviceId) {
        glassesDeviceId = config.deviceId;
        startGlassesPoll();
      }
    },
    getBackend: function() { return activeBackend; },
    getGlassesDeviceId: function() { return glassesDeviceId; }
  };

  // Register MediaSession action handlers once. They delegate to the public
  // API, so they're late-bound against window.crowPlayer (safe).
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play',          function() { window.crowPlayer.toggle(); });
      navigator.mediaSession.setActionHandler('pause',         function() { window.crowPlayer.toggle(); });
      navigator.mediaSession.setActionHandler('previoustrack', function() { window.crowPlayer.prev();   });
      navigator.mediaSession.setActionHandler('nexttrack',     function() { window.crowPlayer.next();   });
      navigator.mediaSession.setActionHandler('stop',          function() { window.crowPlayer.stop();  });
    } catch (e) {}
  }

  // --- Restore state from localStorage ---
  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) {
      if (saved.backend === 'glasses' && saved.glassesDeviceId) {
        // Restore glasses in pending (dimmed) state until first poll confirms
        glassesDeviceId = saved.glassesDeviceId;
        glassesTitle = saved.glassesTitle || '';
        glassesArtist = saved.glassesArtist || '';
        activeBackend = 'glasses';
        bar.style.display = 'block';
        adjustPosition();
        titleEl.textContent = saved.glassesTitle || PAUSED_LABEL;
        if (saved.glassesArtist) {
          subtitleEl.textContent = saved.glassesArtist;
          subtitleEl.style.display = 'block';
        }
        updateNavButtons();
        setPending(true);
        startGlassesPoll();
      } else if (saved.src) {
        bar.style.display = 'block';
        adjustPosition();
        titleEl.textContent = saved.title || PAUSED_LABEL;
        if (saved.subtitle) {
          subtitleEl.textContent = saved.subtitle;
          subtitleEl.style.display = 'block';
        }
        audio.src = saved.src;
        if (saved.metadata) {
          currentMetadata = saved.metadata;
          applyMediaSessionMetadata(saved.metadata);
        }
        audio.addEventListener('loadedmetadata', function onMeta() {
          if (saved.time) {
            try { audio.currentTime = saved.time; } catch (e) {}
          }
          if (saved.wasPlaying) {
            var p = audio.play();
            if (p && p.catch) {
              p.catch(function(err) {
                // Chrome autoplay policy may block on navigation if Media
                // Engagement Index is low. Expose a tap-to-resume overlay.
                console.warn('[crow-player] autoplay blocked:', err && err.name);
                showResumeOverlay();
              });
            }
          }
          audio.removeEventListener('loadedmetadata', onMeta);
        });
        if (saved.queue) { queue = saved.queue; queueIndex = saved.queueIndex || 0; }
        updateNavButtons();
      }
    }
  } catch(e) {}

  // --- Auto-detect glasses bundle on page load ---
  // Check sessionStorage cache first to avoid re-probing every page navigation
  var bundleProbed = false;
  try {
    var cached = sessionStorage.getItem('crow-glasses-bundle');
    if (cached === 'true') { glassesBundleAvailable = true; probeGlassesDevices(); bundleProbed = true; }
    else if (cached === 'false') { glassesBundleAvailable = false; bundleProbed = true; }
  } catch(e) {}

  if (!bundleProbed) {
    fetch('/api/meta-glasses/devices', { credentials: 'same-origin' })
      .then(function(r) {
        if (!r.ok) throw new Error();
        try { sessionStorage.setItem('crow-glasses-bundle', 'true'); } catch(e) {}
        return r.json();
      })
      .then(function(data) {
        glassesBundleAvailable = true;
        var devs = data.devices || [];
        if (devs.length > 0) {
          glassesDeviceId = devs[0].id;
          startGlassesPoll();
        }
      })
      .catch(function() {
        try { sessionStorage.setItem('crow-glasses-bundle', 'false'); } catch(e) {}
        glassesBundleAvailable = false;
      });
  }

  // Re-probe devices every 60s in case glasses connect later
  setInterval(function() {
    if (glassesBundleAvailable && !glassesDeviceId) probeGlassesDevices();
  }, 60000);
})();
`;
}
