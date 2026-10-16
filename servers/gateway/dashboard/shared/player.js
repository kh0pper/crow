/**
 * Persistent Player Bar — Global audio player for the Crow's Nest.
 *
 * Provides a fixed bottom bar with play/pause, seek, queue, next/prev, stop,
 * and localStorage persistence. Any panel can use `window.crowPlayer` to play.
 *
 * Supports three backends:
 *   - "local": HTML5 <audio> element (podcasts, media briefings, Funkwhale proxy, etc.)
 *   - "glasses": Meta-glasses device audio via REST control endpoints
 *   - "kiosk": the Talk to Crow overlay's media (kiosk B3), one item at a time, on the same <audio>.
 *     Internal API for crow-talk.js only: kioskAttach / kioskApply / kioskDetach / kioskOwner.
 *     While the overlay's frame is attached the frame drives the element (validated ops) and hears its
 *     events back; detached (overlay closed, or after a reload) the bar's controls and the element's
 *     ended/error/stall go to /api/kiosk/session/media. No ticket path is ever stored (S3): the reload
 *     marker is {backend:"kiosk", title} and a reload asks the server again.
 *
 * Exports:
 *   playerBarHtml(lang)  — HTML string for the bar (hidden by default)
 *   playerBarJs(lang)    — Inline JS string for the crowPlayer API
 */

import { t, tJs } from "./i18n.js";
import { validatorSource } from "./kiosk-media-protocol.js";

/** Kiosk B3: the bar's side of the hand-off (see crow-talk.js). */
export const KIOSK_MEDIA_URL = "/api/kiosk/session/media";
/** sessionStorage key of this tab's owner nonce: it survives a reload of the tab, never another tab. */
export const KIOSK_OWNER_KEY = "crow-kiosk-bar-owner";
/** Detached: no `playing` this long after waiting/stalled → POST error (the frame's own watchdog is STALL_MS too). */
export const KIOSK_STALL_MS = 15000;

export function playerBarHtml(lang) {
  return `<style>@media(max-width:768px){#crow-player-bar{left:0!important}}</style>
<div id="crow-player-bar" data-turbo-permanent style="display:none;position:fixed;bottom:0;left:var(--crow-sidebar-width,240px);right:0;background:var(--crow-bg-surface);border-top:2px solid var(--crow-accent);z-index:1000;padding:0;transition:left 0.2s">
  <div style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 1rem">
    <button id="crow-player-prev" onclick="window.crowPlayer.prev()" title="${t("player.previous", lang)}" style="background:none;border:none;color:var(--crow-text-muted);cursor:pointer;font-size:0.9rem;padding:0.2rem;display:none">&#9198;</button>
    <button id="crow-player-toggle" onclick="window.crowPlayer.toggle()" title="${t("player.playPause", lang)}" style="background:var(--crow-accent);color:var(--crow-accent-contrast);border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;font-size:1rem;display:flex;align-items:center;justify-content:center;flex-shrink:0">&#9654;</button>
    <button id="crow-player-next" onclick="window.crowPlayer.next()" title="${t("player.next", lang)}" style="background:none;border:none;color:var(--crow-text-muted);cursor:pointer;font-size:0.9rem;padding:0.2rem;display:none">&#9197;</button>
    <button id="crow-player-stop" onclick="window.crowPlayer.stop()" title="${t("player.stop", lang)}" style="background:none;border:none;color:var(--crow-text-muted);cursor:pointer;font-size:0.9rem;padding:0.2rem;display:none">&#9632;</button>
    <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
      <div style="display:flex;align-items:center;gap:0.5rem">
        <div id="crow-player-title" style="font-size:0.8rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none"></div>
        <span id="crow-player-source" style="font-size:0.6rem;color:var(--crow-text-muted);background:var(--crow-bg-elevated);padding:0.05rem 0.35rem;border-radius:3px;display:none;flex-shrink:0"></span>
        <span id="crow-player-time" style="font-size:0.7rem;color:var(--crow-text-muted);font-family:'JetBrains Mono',monospace;flex-shrink:0"></span>
      </div>
      <div id="crow-player-subtitle" style="font-size:0.7rem;color:var(--crow-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none"></div>
      <div id="crow-player-seek-wrap" style="position:relative;height:6px;background:var(--crow-bg-elevated);border-radius:3px;cursor:pointer" onclick="window.crowPlayer._seek(event)">
        <div id="crow-player-progress" style="height:100%;background:var(--crow-accent);border-radius:3px;width:0%;transition:width 0.1s linear"></div>
      </div>
    </div>
    <button id="crow-player-close" onclick="window.crowPlayer.close()" title="${t("player.close", lang)}" aria-label="${t("player.close", lang)}" style="background:none;border:none;color:var(--crow-text-muted);cursor:pointer;font-size:1.2rem;flex-shrink:0;padding:0.2rem">&times;</button>
  </div>
  <audio id="crow-audio" preload="none"></audio>
</div>`;
}

export function playerBarJs(lang) {
  return `
(function() {
  var audio = document.getElementById('crow-audio');
  var bar = document.getElementById('crow-player-bar');
  // Early-return if this page has no player bar (non-dashboard layouts, or the player shell inside a frame:
  // its top-level-only guard removed the bar, see player-shell.js).
  if (!audio || !bar) return;
  // Under Turbo Drive, this IIFE re-executes on every nav, but the audio
  // element rides along inside the data-turbo-permanent bar. Check the dataset
  // flag to avoid re-attaching listeners to the same persistent element.
  // The <audio> itself must NOT be data-turbo-permanent: nested inside the
  // permanent bar, Turbo preserves it a second time, leaves a cloneNode() copy
  // in the bar and the real element outside the document, where Chrome pauses
  // it (tests/player-bar-turbo-nav-live.test.js).
  if (audio.dataset.crowPlayerInitialized === '1') return;
  audio.dataset.crowPlayerInitialized = '1';
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
  var closeBtn = document.getElementById('crow-player-close');

  var PLAY_ICON = '\\u25B6';
  var PAUSE_ICON = '\\u23F8';
  var PLAYING_LABEL = '${tJs("player.playing", lang)}';
  var PAUSED_LABEL = '${tJs("player.paused", lang)}';
  var SOURCE_GLASSES = '${tJs("player.sourceGlasses", lang)}';
  var ENDED_LABEL = '${tJs("player.ended", lang)}';
  var CLOSE_LABEL = '${tJs("player.close", lang)}';
  var DISMISS_LABEL = '${tJs("player.dismiss", lang)}';

  var queue = [];
  var queueIndex = -1;
  var saveTimer = null;
  var STORAGE_KEY = 'crow-player-state';
  var currentMetadata = null;
  var closedByUser = false;
  var endedNote = false;   // the bar shows "Playback ended" for an item that cannot come back (Q1)

  // --- Which tab is this? (bar on every Crow page, H2/H3) ---
  // TAB_KEY: "this tab has played". Held in memory while the page lives and written to sessionStorage only on
  // pagehide, then consumed on the next load: so the same tab's next page (a reload, a visit to the artifact
  // viewer, Back) finds it, while a tab duplicated or opened from a live page (sessionStorage copied) does not.
  // A local item that was playing auto-resumes only in a tab that had it; a new tab shows it paused.
  var TAB_KEY = 'crow-player-tab';
  var tabPlayed = false;
  try { tabPlayed = sessionStorage.getItem(TAB_KEY) === '1'; sessionStorage.removeItem(TAB_KEY); } catch (e) {}
  var tabHadFlag = tabPlayed;

  // --- Backend state ---
  var activeBackend = 'local'; // 'local' | 'glasses' | 'kiosk'
  var glassesDeviceId = null;
  var glassesState = 'idle'; // 'idle' | 'playing' | 'paused'
  var glassesTitle = '';
  var glassesArtist = '';
  var glassesPollTimer = null;
  var glassesDeviceProbeTimer = null;
  var glassesBundleAvailable = null; // null = unknown, true/false after probe
  var glassesPending = false; // true during restore-from-localStorage until first poll

  // --- Hand-off debug ring (bar-handoff fix, 2026-10-16) ---
  // What happened to the element and the kiosk hand-off, newest last, in memory only (never stored, never sent):
  // attach/detach (resume, volume), loads by item id, play() results with the refusal's name, every pause with
  // who asked for it ("browser" = nobody in this script: the OS, the WebView, a removal from the page), visits.
  // Never a URL: no ticket path can reach it. Long-press the bar's title to see it; window.crowPlayer.debug().
  var DBG_MAX = 40, dbgLines = [], dbgBox = null, dbgHold = null, pauseSrc = '';
  function dbg(text) {
    dbgLines.push(new Date().toISOString().slice(14, 23) + ' ' + text);
    if (dbgLines.length > DBG_MAX) dbgLines.shift();
    if (dbgBox && dbgBox.style.display !== 'none') dbgBox.textContent = dbgLines.join('\\n');
  }
  /** This script's own pause, named in the ring (an already-paused element fires no event, so nothing is named). */
  function pauseBy(src) {
    if (!audio.paused) pauseSrc = src;
    try { audio.pause(); } catch (e) {}
  }
  /**
   * pauseBy, then empty the element. load() drops the still-queued pause event, so the pause is named here (with
   * the backend it left) and its label cleared: a stale one would name the NEXT pause, the browser's or the OS's.
   */
  function pauseAndEmpty(src, from) {
    pauseBy(src);
    try { audio.removeAttribute('src'); audio.load(); } catch (e) {}
    if (pauseSrc) dbg('pause by=' + pauseSrc + ' inDoc=' + (audio.isConnected === false ? 0 : 1) + ' ' + from);
    pauseSrc = '';
  }

  function fmt(s) {
    if (!s || !isFinite(s)) return '0:00';
    var m = Math.floor(s / 60);
    var sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function updateTime() {
    if (activeBackend === 'glasses' || (activeBackend === 'kiosk' && (!kioskItem || kioskItem.live))) { timeEl.textContent = ''; return; }
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
    } else if (activeBackend === 'kiosk') {
      var k = kioskItem || {};
      prevBtn.style.display = k.has_previous ? 'block' : 'none';
      nextBtn.style.display = k.has_next ? 'block' : 'none';
      stopBtn.style.display = 'block';
      seekWrap.style.display = k.live ? 'none' : 'block';
      timeEl.style.display = k.live ? 'none' : '';
      sourceEl.textContent = k.source || '';
      sourceEl.style.display = k.source ? 'inline' : 'none';
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

  /**
   * Q1: an item that cannot come back (a Crow restart, superseded by another tab, a logout, its end) never
   * vanishes silently: the bar keeps its title, says "Playback ended", ⏯ is off and × dismisses it.
   * Never saved as a marker; the next item clears it.
   */
  function showEnded(title) {
    endedNote = true;
    activeBackend = 'local';
    queue = []; queueIndex = -1;
    bar.style.display = 'block';
    setPending(false);
    adjustPosition();
    titleEl.textContent = title || '';
    subtitleEl.textContent = ENDED_LABEL;
    subtitleEl.style.display = 'block';
    progressEl.style.width = '0%';
    timeEl.textContent = '';
    updateNavButtons();
    updateToggleIcon();
    seekWrap.style.display = 'none';
    toggleBtn.disabled = true;
    toggleBtn.style.opacity = '0.4';
    toggleBtn.style.animation = '';
    toggleBtn.style.boxShadow = '';
    if (closeBtn) { closeBtn.title = DISMISS_LABEL; closeBtn.setAttribute('aria-label', DISMISS_LABEL); }
    dbg('ended note');
  }
  function clearEnded() {
    if (!endedNote) return;
    endedNote = false;
    toggleBtn.disabled = false;
    toggleBtn.style.opacity = '';
    if (closeBtn) { closeBtn.title = CLOSE_LABEL; closeBtn.setAttribute('aria-label', CLOSE_LABEL); }
  }

  function saveState() {
    // NOTE: the marker is shared by every tab (localStorage). A second tab showing an item paused writes it on
    // its pagehide too (wasPlaying:false); a tab that is playing re-saves within 5 s (throttledSave).
    if (closedByUser || endedNote) return;
    if (bar.style.display === 'none') return;
    if (activeBackend === 'kiosk') {
      // S3: the ticket path never reaches storage; a reload asks the server (GET) instead.
      if (!kioskItem) return;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ backend: 'kiosk', title: titleEl.textContent })); } catch (e) {}
      return;
    }
    if (String(audio.src || '').indexOf('/display/t/') !== -1) return;   // S3: never a ticket path, whatever the backend
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
  audio.addEventListener('play', function() { tabPlayed = true; updateToggleIcon(); saveState(); });
  audio.addEventListener('pause', function() {
    updateToggleIcon(); saveState();
    dbg('pause by=' + (pauseSrc || 'browser') + ' inDoc=' + (audio.isConnected === false ? 0 : 1) + ' ' + activeBackend);
    pauseSrc = '';
  });
  audio.addEventListener('playing', function() { dbg('playing ' + activeBackend); });
  document.addEventListener('turbo:visit', function() { dbg('nav'); });
  // Save immediately on navigation — pagehide fires for tab close + cross-origin nav.
  window.addEventListener('pagehide', function() {
    saveState();
    if (tabPlayed) { try { sessionStorage.setItem(TAB_KEY, '1'); } catch (e) {} }
  });
  // Back/forward cache: the page lives on, so the flag goes back to memory only.
  window.addEventListener('pageshow', function(e) { if (e && e.persisted) { try { sessionStorage.removeItem(TAB_KEY); } catch (x) {} } });
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
  // Continuous-playback recovery: the original 'ended' handler only fires
  // on a clean end-of-stream. Buffer underruns, stream-side closes, and
  // 4xx/5xx responses leave the audio element silently stuck. Add a
  // retry-once-then-skip watchdog so an album of N tracks reliably plays
  // through end-to-end on flaky networks.
  var stallTimer = null;
  var retriedThisTrack = false;
  // The kiosk backend has its own rules (the frame or the server decides what comes next).
  function clearStall() {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
  }
  function armStall() {
    clearStall();
    if (activeBackend === 'kiosk') return;
    stallTimer = setTimeout(function() {
      if (!retriedThisTrack) {
        retriedThisTrack = true;
        try { audio.load(); var p = audio.play(); if (p && p.catch) p.catch(function(){}); } catch (e) {}
      } else if (queueIndex < queue.length - 1) {
        try { console.warn('[crowPlayer] stall watchdog: skipping track', queueIndex); } catch (e) {}
        window.crowPlayer.next();
      }
    }, 8000);
  }
  audio.addEventListener('error', function() {
    if (activeBackend === 'kiosk') return;
    try { console.warn('[crowPlayer] audio error', audio.error && audio.error.code); } catch (e) {}
    if (queueIndex < queue.length - 1) {
      setTimeout(function() { window.crowPlayer.next(); }, 500);
    }
  });
  audio.addEventListener('stalled', armStall);
  audio.addEventListener('waiting', armStall);
  audio.addEventListener('playing', function() { clearStall(); retriedThisTrack = false; });
  audio.addEventListener('loadstart', function() { clearStall(); retriedThisTrack = false; });

  audio.addEventListener('ended', function() {
    clearStall();
    if (activeBackend === 'kiosk') return;
    if (queueIndex < queue.length - 1) {
      window.crowPlayer.next();
    } else {
      updateToggleIcon();
    }
  });

  function adjustPosition() {
    bar.style.left = (window.innerWidth <= 768) ? '0' : 'var(--crow-sidebar-width,240px)';
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
    clearEnded();
    leaveKiosk(true);
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


  // The ring on the phone: long-press the title (or the phone's own long-press menu); a tap on it hides it.
  function showDbg() {
    if (!dbgBox) {
      dbgBox = document.createElement('div');
      dbgBox.id = 'crow-player-debug';
      dbgBox.setAttribute('role', 'log');
      dbgBox.style.cssText = 'position:absolute;bottom:100%;left:0;right:0;max-height:50vh;overflow:auto;white-space:pre-wrap;font:11px/1.35 monospace;background:var(--crow-bg-elevated);color:var(--crow-text-primary);border-top:1px solid var(--crow-border);padding:0.4rem 0.6rem';
      dbgBox.addEventListener('click', function() { dbgBox.style.display = 'none'; });
      bar.appendChild(dbgBox);
    }
    dbgBox.textContent = dbgLines.length ? dbgLines.join('\\n') : '(empty)';
    dbgBox.style.display = 'block';
  }
  function dbgCancel() { if (dbgHold) { clearTimeout(dbgHold); dbgHold = null; } }
  titleEl.addEventListener('pointerdown', function() { dbgCancel(); dbgHold = setTimeout(function() { dbgHold = null; showDbg(); }, 700); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function(type) { titleEl.addEventListener(type, dbgCancel); });
  titleEl.addEventListener('contextmenu', function(e) { e.preventDefault(); dbgCancel(); showDbg(); });

  // --- Kiosk backend (B3): the Talk to Crow overlay's media ---
  // The validator below is kiosk-media-protocol.js's own text (validatorSource), so the
  // tested function and the shipped one are the same.
  ${validatorSource()}
  var KIOSK_URL = ${JSON.stringify(KIOSK_MEDIA_URL)};
  var KIOSK_OWNER_KEY = ${JSON.stringify(KIOSK_OWNER_KEY)};
  var KIOSK_STALL_MS = ${KIOSK_STALL_MS};
  var kioskItem = null;     // { id, url, title, subtitle, source, live, has_next, has_previous }
  var kioskPost = null;     // the frame's postMessage, while attached
  var kioskIsLive = null;   // () → is that frame still the live one (review 2)
  var kioskEpoch = 0;       // bumped whenever the bar moves on: a late answer for an older state is dropped
  var kioskStall = null, kioskRetry = null, kioskOwnerMem = null;
  var kioskRedo = null;     // an ended/error report the server failed (5xx): ⏯ sends it again
  var kioskRestoring = false, kioskSavedTitle = '';
  var KIOSK_CLAIM_MS = 300;

  /** The kiosk's level curve (media-view levelOf): 0–100 from the server → the element's 0–1. */
  function kioskLevel(v, muted) {
    if (muted || !(v > 0)) return 0;
    return Math.min(1, Math.pow(10, (Math.min(100, v) - 100) / 40));
  }
  /** This tab's stored nonce, or null (never mints). */
  function kioskStored() {
    var o = null;
    try { o = sessionStorage.getItem(KIOSK_OWNER_KEY); } catch (e) {}
    if (o && /^[A-Za-z0-9_-]{16,64}$/.test(o)) return o;
    return kioskOwnerMem;
  }
  function kioskOwner() { return kioskStored() || kioskMint(); }
  function kioskMint() {
    var o;
    var abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    var bytes = new Uint8Array(24);
    try { crypto.getRandomValues(bytes); } catch (e) { for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); }
    o = '';
    for (var j = 0; j < bytes.length; j++) o += abc.charAt(bytes[j] % 64);
    kioskOwnerMem = o;
    try { sessionStorage.setItem(KIOSK_OWNER_KEY, o); } catch (e) {}
    return o;
  }
  /**
   * Review 1: a duplicated tab (Duplicate tab, window.open) copies sessionStorage, nonce included. At startup the
   * stored nonce is claimed on a BroadcastChannel: a live tab holding it answers, and this tab mints its own.
   * done() runs once the claim settles (answered, or KIOSK_CLAIM_MS of silence); at once with no channel.
   */
  function kioskClaim(done) {
    var o = kioskStored(), finished = false, timer = null, ch = null;
    function end() { if (finished) return; finished = true; if (timer) clearTimeout(timer); done(); }
    try { ch = new BroadcastChannel('crow-kiosk-owner'); } catch (e) { ch = null; }
    if (!ch) { end(); return; }
    ch.onmessage = function (e) {
      var d = e && e.data;
      if (!d || typeof d !== 'object' || typeof d.n !== 'string') return;
      var mine = kioskStored();
      if (d.q === 1 && mine && d.n === mine) { try { ch.postMessage({ a: 1, n: mine }); } catch (x) {} }
      else if (d.a === 1 && !finished && o && d.n === o && mine === o) { kioskOwnerMem = null; kioskMint(); end(); }
    };
    if (!o) { end(); return; }
    try { ch.postMessage({ q: 1, n: o }); } catch (e) { end(); return; }
    timer = setTimeout(end, KIOSK_CLAIM_MS);
  }
  function kioskCookie(name) {
    var parts = String(document.cookie || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].replace(/^ +/, '');
      if (p.indexOf(name + '=') === 0) return p.slice(name.length + 1);
    }
    return '';
  }
  /** Attached = a frame registered AND it is still the live frame (Android Back can swap the body without a close). */
  function kioskAttached() {
    if (!kioskPost) return false;
    var live = false;
    try { live = !kioskIsLive || kioskIsLive() === true; } catch (e) { live = false; }
    if (!live) { kioskPost = null; kioskIsLive = null; }
    return live;
  }
  function kioskToFrame(type, extra) {
    if (!kioskItem || !kioskAttached()) return false;
    var m = { crow: 'media-event', v: 1, id: kioskItem.id, type: type };
    if (extra) for (var k in extra) m[k] = extra[k];
    try { kioskPost(m); } catch (e) {}
    return true;
  }
  function kioskTimersOff() {
    if (kioskStall) { clearTimeout(kioskStall); kioskStall = null; }
    if (kioskRetry) { clearTimeout(kioskRetry); kioskRetry = null; }
  }
  /** Show an item (a validated load) on the bar. Does not touch src or play. */
  function kioskShow(m) {
    closedByUser = false;
    clearEnded();
    activeBackend = 'kiosk';
    kioskRedo = null; kioskRestoring = false;
    queue = []; queueIndex = -1;
    kioskItem = { id: m.id, url: m.url, title: m.title, subtitle: m.subtitle, source: m.source, live: m.live, has_next: m.has_next, has_previous: m.has_previous };
    bar.style.display = 'block';
    setPending(false);
    adjustPosition();
    titleEl.textContent = m.title || PLAYING_LABEL;
    if (m.subtitle) { subtitleEl.textContent = m.subtitle; subtitleEl.style.display = 'block'; }
    else { subtitleEl.textContent = ''; subtitleEl.style.display = 'none'; }
    progressEl.style.width = '0%';
    timeEl.textContent = '';
    updateNavButtons();
    updateToggleIcon();
    applyMediaSessionMetadata({ title: m.title, artist: m.subtitle });
    saveState();
  }
  function kioskSetSrc(url) {
    kioskTimersOff();
    audio.src = url;
  }
  /** ctx names the caller in the ring. A refusal (anything but AbortError: a newer src or pause won) pulses ⏯. */
  function kioskPlay(ctx) {
    var p;
    try { p = audio.play(); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(function () { dbg('play ok (' + ctx + ')'); }, function (err) {
      var name = String((err && err.name) || 'Error').slice(0, 40);
      dbg('play refused ' + name + ' (' + ctx + ')');
      if (name !== 'AbortError') showResumeOverlay();
    });
  }
  /**
   * The bar lets the overlay's media go: silent, no marker. Never calls the server itself.
   * note: the server ended it (an answer, not the user's own stop): the bar says Playback ended (Q1) instead
   * of hiding. A restore in a tab that did not start with its own nonce (a new or duplicated tab, H2) finds
   * nothing of its own: it hides and leaves the shared marker alone, it is another tab's.
   */
  function kioskClear(note) {
    kioskEpoch++;
    kioskTimersOff();
    var had = activeBackend === 'kiosk';
    var restoring = kioskRestoring;
    var title = had ? titleEl.textContent : kioskSavedTitle;
    kioskItem = null; kioskRedo = null; kioskRestoring = false;
    if (!had) {
      if (restoring && !ownTab) { dbg('restore: nothing for this tab'); return; }
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}   // a reload marker with nothing behind it
      if (note && restoring) showEnded(title || PAUSED_LABEL);
      return;
    }
    dbg('clear');
    pauseAndEmpty('clear', activeBackend);
    activeBackend = 'local';
    if (note) showEnded(title);
    else { bar.style.display = 'none'; updateNavButtons(); }
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }
  function kioskAnswer(epoch, verb) {
    return function (r) {
      dbg('server ' + (verb || 'get') + ' ' + r.status);
      if (epoch !== kioskEpoch) return;
      if (r.status === 200) return r.json().then(function (v) { if (epoch === kioskEpoch) kioskApplyView(v); });
      if (r.status === 409 || r.status === 401 || r.status === 403 || r.status === 404) { kioskClear(true); return; }   // S8: superseded or logged out
      // Review 4: the server never heard that the item ended or failed. Keep the bar, paused, ⏯ pulsing: a tap retries.
      if (r.status >= 500 && (verb === 'ended' || verb === 'error') && kioskItem) {
        kioskRedo = verb;
        pauseBy('redo');
        updateToggleIcon();
        showResumeOverlay();
      }
    };
  }
  /** Detached: one verb about the bar's own item. The answer (the new view) is applied unless the bar moved on. */
  function kioskSend(verb) {
    if (!kioskItem) return;
    var owner = kioskOwner();
    fetch(KIOSK_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Crow-Csrf': kioskCookie('crow_csrf') },
      body: JSON.stringify({ do: verb, id: kioskItem.id, owner: owner }),
    }).then(kioskAnswer(kioskEpoch, verb)).catch(function () {});
  }
  /** A reload, or a station reload's retry: what does the server hold for this tab? */
  function kioskGet() {
    fetch(KIOSK_URL, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { 'X-Crow-Owner': kioskOwner() } })
      .then(kioskAnswer(kioskEpoch)).catch(function () {});
  }
  /** A verb from the bar's own controls: through the frame while attached (it tells the server), else POST. */
  function kioskCommand(verb) {
    if (!kioskItem) return;
    if (kioskToFrame('cmd', { do: verb })) return;
    kioskSend(verb);
  }
  /** The server's one-item view (GET/POST answer). Its item goes through the same validator as a frame's load. */
  function kioskApplyView(v) {
    if (!v || typeof v !== 'object') return;
    var it = v.item;
    if (!it || typeof it !== 'object') { kioskClear(true); return; }
    if (it.url === null && !kioskItem && kioskRestoring) {
      // Review 5: a reload while a station reload is pending: the saved title stays on the bar until it is due.
      activeBackend = 'kiosk';
      bar.style.display = 'block';
      adjustPosition();
      titleEl.textContent = kioskSavedTitle || PAUSED_LABEL;
      subtitleEl.style.display = 'none';
      updateNavButtons();
    }
    if (it.url === null && (kioskItem ? it.id === kioskItem.id : kioskRestoring)) {
      // A station reload is pending (D4): ask again once it is due.
      var wait = Number(v.retry_ms);
      if (kioskRetry) clearTimeout(kioskRetry);
      kioskRetry = setTimeout(function () { kioskRetry = null; kioskGet(); }, isFinite(wait) ? Math.max(250, Math.min(wait, 60000)) : 1000);   // floored: never a tight loop
      return;
    }
    var m = validateFrameMessage({ crow: 'media', v: 1, op: 'load', id: it.id, url: it.url, title: it.title, subtitle: it.subtitle || '', source: it.source || '', live: it.live === true, has_next: v.has_next === true, has_previous: v.has_previous === true });
    if (!m) { kioskClear(true); return; }
    var same = activeBackend === 'kiosk' && kioskItem && kioskItem.id === m.id && kioskItem.url === m.url;
    if (!same) {
      if (activeBackend !== 'kiosk') leaveOtherForKiosk();
      kioskEpoch++;
      kioskShow(m);
      kioskSetSrc(m.url);
    } else {
      kioskItem.has_next = m.has_next; kioskItem.has_previous = m.has_previous;
      updateNavButtons();
    }
    audio.volume = kioskLevel(v.volume, v.muted);
    if (v.state === 'paused') { pauseBy('server'); return; }
    if (!same || audio.paused) kioskPlay('server');
  }
  /** The kiosk takes the bar: whatever the local queue played stops (its src is replaced next). */
  function leaveOtherForKiosk() {
    clearStall();
    queue = []; queueIndex = -1;
    pauseBy('kiosk');
  }
  /**
   * The bar leaves the kiosk backend (the Media app or the glasses take it): the overlay's item is stopped (review 4)
   * and the element falls silent with no ticket src left on it (S3), unless the caller sets a new src next.
   */
  function leaveKiosk(replacing) {
    kioskEpoch++;
    kioskRestoring = false;
    if (activeBackend !== 'kiosk') return;
    if (kioskItem) kioskCommand('stop');
    kioskEpoch++;
    kioskTimersOff();
    kioskItem = null; kioskRedo = null;
    activeBackend = 'local';
    if (replacing) return;
    pauseAndEmpty('leave', 'kiosk');
  }
  /** A validated frame op. Every op but load names its item and is ignored unless that item is on the bar (review 3). */
  function kioskApply(raw) {
    var m = validateFrameMessage(raw);
    if (!m) return;
    if (m.op === 'load') {
      if (activeBackend === 'kiosk' && kioskItem && kioskItem.id === m.id && kioskItem.url === m.url) {
        dbg('load ' + m.id + ' same');
        kioskItem.has_next = m.has_next; kioskItem.has_previous = m.has_previous;
        updateNavButtons();
        kioskToFrame(audio.paused ? 'pause' : 'playing');   // a reopened overlay finds it as it is
        return;
      }
      dbg('load ' + m.id + (m.live ? ' live' : ''));
      if (activeBackend !== 'kiosk') leaveOtherForKiosk();
      kioskEpoch++;
      kioskShow(m);
      kioskSetSrc(m.url);
      audio.volume = m.volume;
      return;
    }
    if (activeBackend !== 'kiosk' || !kioskItem || m.id !== kioskItem.id) return;
    if (m.op === 'play') {
      var id = m.id, p;
      try { p = audio.play(); } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(function () {
        dbg('play ok (frame)');
        if (kioskItem && kioskItem.id === id) kioskToFrame('play-result', { ok: true });
      }, function (err) {
        var name = String((err && err.name) || 'Error').slice(0, 40);
        dbg('play refused ' + name + ' (frame)');
        if (kioskItem && kioskItem.id === id) kioskToFrame('play-result', { ok: false, name: name });
      });
    } else if (m.op === 'pause') pauseBy('frame');
    else if (m.op === 'volume') audio.volume = m.volume;
    else if (m.op === 'stop') kioskClear();
  }
  // The element's events: to the frame while attached; detached, ended/error/stall go to the server.
  ['playing', 'pause', 'ended', 'error', 'waiting', 'stalled'].forEach(function (type) {
    audio.addEventListener(type, function () {
      if (activeBackend !== 'kiosk' || !kioskItem) return;
      // I2: a refused stream (e.g. the ticket's 429 on a fast reload) reaches the element as an error: name its code.
      if (type === 'error') dbg('media error ' + ((audio.error && audio.error.code) || '?') + ' ' + kioskItem.id);
      if (kioskToFrame(type)) return;
      if (type === 'playing' || type === 'pause') { if (kioskStall) { clearTimeout(kioskStall); kioskStall = null; } return; }
      if (type === 'waiting' || type === 'stalled') {
        if (!kioskStall && !audio.paused) kioskStall = setTimeout(function () { kioskStall = null; if (activeBackend === 'kiosk') kioskSend('error'); }, KIOSK_STALL_MS);
        return;
      }
      if (kioskStall) { clearTimeout(kioskStall); kioskStall = null; }
      kioskSend(type);
    });
  });

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
    clearEnded();
    leaveKiosk();
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
    if (activeBackend === 'kiosk' && kioskItem) return;   // the overlay's media keeps the bar
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
      if (activeBackend === 'kiosk') { kioskCommand('next'); return; }
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
      if (activeBackend === 'kiosk') { kioskCommand('previous'); return; }
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
      if (endedNote) return;
      if (activeBackend === 'kiosk') {
        if (!kioskItem) return;
        // Attached: a pause acts here at once (always safe; the frame hears the element's pause and tells the server).
        // A resume goes to the frame as a command (review 3): its mic gate decides when it plays.
        if (!audio.paused && kioskAttached()) { pauseBy('toggle'); return; }
        if (audio.paused && kioskToFrame('cmd', { do: 'resume' })) return;
        if (kioskRedo) { var redo = kioskRedo; kioskRedo = null; kioskSend(redo); return; }
        if (!audio.paused) { pauseBy('toggle'); kioskSend('pause'); return; }
        // A station resumes live on a new ticket (the answer brings it); a track resumes here at once.
        if (!kioskItem.live) kioskPlay('toggle');
        kioskSend('resume');
        return;
      }
      if (activeBackend === 'glasses') {
        var action = glassesState === 'paused' ? 'resume' : 'pause';
        glassesState = (action === 'pause') ? 'paused' : 'playing';
        updateToggleIcon();
        glassesControl(action);
        return;
      }
      if (audio.paused) audio.play().catch(function() {}); else pauseBy('toggle');
    },

    stop: function() {
      closedByUser = true;
      if (activeBackend === 'kiosk') { kioskCommand('stop'); kioskClear(); return; }
      if (activeBackend === 'glasses') {
        glassesControl('stop');
        hideGlassesBar();
        return;
      }
      clearEnded();
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
      if (activeBackend === 'kiosk') { kioskCommand('stop'); kioskClear(); return; }
      if (activeBackend === 'glasses') {
        glassesControl('stop');
        hideGlassesBar();
        return;
      }
      clearEnded();
      audio.pause();
      audio.src = '';
      bar.style.display = 'none';
      queue = [];
      queueIndex = -1;
      try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
    },

    _seek: function(e) {
      if (activeBackend === 'glasses') return; // no seek for glasses
      if (activeBackend === 'kiosk' && (!kioskItem || kioskItem.live)) return;
      if (!audio.duration) return;
      var rect = seekWrap.getBoundingClientRect();
      var pct = (e.clientX - rect.left) / rect.width;
      audio.currentTime = pct * audio.duration;
    },

    getQueue: function() { return queue.slice(); },
    getQueueIndex: function() { return queueIndex; },

    // --- Backend API ---
    setBackend: function(type, config) {
      if (type === 'kiosk') return;   // only a frame's load puts the bar on the kiosk backend
      leaveKiosk();
      activeBackend = type;
      if (type === 'glasses' && config && config.deviceId) {
        glassesDeviceId = config.deviceId;
        startGlassesPoll();
      }
    },
    getBackend: function() { return activeBackend; },
    getGlassesDeviceId: function() { return glassesDeviceId; },

    // --- Kiosk backend (internal: crow-talk.js only) ---
    /** The overlay's frame is up: post(obj) reaches it; isLive() says whether it still is. */
    kioskAttach: function(post, isLive) {
      if (typeof post !== 'function') return;
      dbg('attach');
      kioskPost = post;
      kioskIsLive = typeof isLive === 'function' ? isLive : null;
    },
    /** A message from the frame (the parent has checked origin + source); validated here again. */
    kioskApply: kioskApply,
    /** The frame is going: { volume, resume } is what crowKioskRelease() returned (the un-ducked level, un-hold). */
    kioskDetach: function(s) {
      kioskPost = null; kioskIsLive = null;
      dbg('detach ' + (s && typeof s === 'object' ? 'resume=' + (s.resume === true) + ' volume=' + (typeof s.volume === 'number' && isFinite(s.volume) ? Math.round(s.volume * 100) / 100 : '-') : '(no state)') + ' paused=' + audio.paused + ' ' + activeBackend);
      if (activeBackend !== 'kiosk' || !kioskItem || !s || typeof s !== 'object') return;
      if (typeof s.volume === 'number' && isFinite(s.volume)) audio.volume = Math.max(0, Math.min(1, s.volume));
      if (s.resume === true && audio.paused) kioskPlay('detach');
    },
    /** This tab's owner nonce (sent in the frame's hello and with every request). */
    kioskOwner: kioskOwner,
    /** The hand-off debug ring (a copy, newest last). */
    debug: function() { return dbgLines.slice(); }
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
  var startNonce = kioskStored(), ownTab = false;
  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) {
      if (saved.backend === 'kiosk') {
        // The overlay's media outlived the page: ask the server what this tab's bar holds (never a stored path),
        // once this tab's nonce is its own (review 1: see kioskClaim).
        kioskRestoring = true;
        kioskSavedTitle = typeof saved.title === 'string' ? saved.title.slice(0, 80) : '';
      } else if (saved.backend === 'glasses' && saved.glassesDeviceId) {
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
        // preload="none" (the bar's default) never fetches metadata, so loadedmetadata would never fire and the
        // saved position and play state would never come back: ask for the metadata of a restored item.
        audio.preload = 'metadata';
        audio.src = saved.src;
        if (saved.metadata) {
          currentMetadata = saved.metadata;
          applyMediaSessionMetadata(saved.metadata);
        }
        audio.addEventListener('loadedmetadata', function onMeta() {
          if (saved.time) {
            try { audio.currentTime = saved.time; } catch (e) {}
          }
          // H3: only the tab that was playing it resumes it; a new tab shows it paused (a tap plays it there).
          if (saved.wasPlaying && tabHadFlag) {
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
  // I1: this is the tab's own session only if it started with a nonce AND that nonce survived the claim
  // (a duplicated tab's copy is answered by the live tab and re-minted).
  kioskClaim(function () {
    ownTab = !!startNonce && kioskStored() === startNonce;
    if (kioskRestoring) kioskGet();
  });

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
        // Cache 'false' ONLY on an explicit 404 (bundle not installed) — a
        // transient error (network blip, 401, 500) must not poison the
        // tab-session cache, which the notifications PTT poll also honors.
        if (r.status === 404) {
          try { sessionStorage.setItem('crow-glasses-bundle', 'false'); } catch(e) {}
          throw new Error();
        }
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
