/**
 * Crow's Nest Panel — Music.
 *
 * Mobile-friendly music player. Browses the Funkwhale library (via the
 * Funkwhale bundle's browse/search endpoints), plays tracks through the
 * persistent window.crowPlayer bar (local HTML5 audio OR glasses via REST),
 * and surfaces native Android media controls via navigator.mediaSession.
 *
 * Graceful degradation: if the Funkwhale bundle isn't installed, shows a
 * Setup CTA instead of crashing.
 *
 * XSS-safe (createElement / textContent only).
 */

const CLIENT_SCRIPT = `
(function() {
  // Idempotency guard for Turbo Drive: the panel's root container is
  // swapped fresh on each nav, so a data-initialized flag on the same
  // element prevents a duplicate init if this IIFE ever fires twice on
  // the same DOM (e.g., Turbo render-then-cache-restore). All listeners
  // are element-scoped and auto-GC when the body is swapped.
  var __musicRoot = document.getElementById('music-root');
  if (!__musicRoot) return;
  if (__musicRoot.dataset.initialized === '1') return;
  __musicRoot.dataset.initialized = '1';

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'className') e.className = attrs[k];
      else if (k === 'style') e.style.cssText = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  var state = {
    view: 'browse',       // browse | recent | search
    browse: { level: 'artists', artistId: null, artistName: '', albumId: null, albumTitle: '', albumArtist: '' },
    searchQuery: '',
    searchAbort: null,
    searchTimer: null,
    browseAbort: null,    // paginate() AbortController — one at a time
  };

  function root() { return document.getElementById('music-root'); }

  // ---------- Setup check ----------

  async function checkFunkwhale() {
    try {
      var res = await fetch('/api/funkwhale/status', { credentials: 'same-origin' });
      if (!res.ok) return false;
      var data = await res.json();
      return !data.error;
    } catch (_) { return false; }
  }

  function renderSetupCTA(reason) {
    var r = root(); clear(r);
    var wrap = el('div', { className: 'music-empty' });
    wrap.appendChild(el('h2', null, 'Music needs a library'));
    wrap.appendChild(el('p', null, reason || 'Install and configure the Funkwhale bundle to browse your music library.'));
    var link = el('a', { href: '/dashboard/extensions', className: 'btn btn-primary' }, 'Open Extensions');
    wrap.appendChild(link);
    r.appendChild(wrap);
  }

  // ---------- View switch ----------

  var viewRendered = false;
  function setView(v) {
    // Clicking an already-rendered active tab is a no-op (preserves scroll
    // + in-flight pagination). But the first call still needs to render
    // even though state.view starts at 'browse'.
    if (state.view === v && viewRendered) return;
    if (state.view === 'browse' && state.browseAbort) {
      try { state.browseAbort.abort(); } catch (_) {}
      state.browseAbort = null;
    }
    if (state.view === 'search' && state.searchAbort) {
      try { state.searchAbort.abort(); } catch (_) {}
      state.searchAbort = null;
    }
    state.view = v;
    viewRendered = true;
    var tabs = document.querySelectorAll('.music-tab');
    tabs.forEach(function(t) { t.classList.toggle('active', t.getAttribute('data-view') === v); });
    if (v === 'browse') renderBrowse();
    else if (v === 'recent') renderRecent();
    else if (v === 'search') renderSearchResults();
  }

  // Shared pagination helper. Per-invocation local observer + AbortController;
  // no globals. Hard cap at 50 pages guards against malformed upstream.
  // Observer arming is INSIDE loadPage's first-page success branch to prevent
  // the auto-retry loop that would otherwise trigger on persistent 401/500
  // (IntersectionObserver fires an initial callback for intersecting targets).
  async function paginate(r, urlBase, pageSize, appendRows) {
    if (state.browseAbort) { try { state.browseAbort.abort(); } catch (_) {} }
    var ctrl = new AbortController();
    state.browseAbort = ctrl;

    var page = 1;
    var loadedCount = 0;
    var isLoading = false;
    var listContainer = null;
    var sentinel = null;
    var observer = null;
    var MAX_PAGES = 50;

    // Sentinel attached BEFORE any fetch so a first-page failure has a retry
    // affordance (same code path as N-th-page failure).
    sentinel = el('div', { className: 'music-load-more' }, 'Loading...');
    r.appendChild(sentinel);

    async function loadPage() {
      if (ctrl.signal.aborted || page > MAX_PAGES) return;
      isLoading = true;
      var wasFirstPage = (listContainer === null);
      try {
        var sep = urlBase.indexOf('?') >= 0 ? '&' : '?';
        var url = urlBase + sep + 'page=' + page + '&page_size=' + pageSize;
        var res = await fetch(url, { credentials: 'same-origin', signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();
        if (ctrl.signal.aborted) return;
        var results = Array.isArray(data.results) ? data.results : [];
        var count = typeof data.count === 'number' ? data.count : null;

        if (wasFirstPage) {
          if (results.length === 0) {
            sentinel.remove();
            sentinel = null;
            r.appendChild(el('div', { className: 'music-empty' }, 'Nothing to show.'));
            return;
          }
          listContainer = appendRows(r, results, true, sentinel);
        } else {
          appendRows(listContainer, results, false, sentinel);
        }
        loadedCount += results.length;
        page += 1;

        var capHit = (page > MAX_PAGES);
        var more = (results.length >= pageSize)
          && (count === null || loadedCount < count)
          && !capHit;

        if (!more) {
          if (observer) { observer.disconnect(); observer = null; }
          sentinel.textContent = capHit
            ? 'Too many results - use search to find specific items.'
            : 'End of library';
          sentinel.onclick = null;
        } else if (wasFirstPage) {
          // Arm observer only after first-page success. At this point
          // isLoading is STILL true (finally runs after this block), so
          // IntersectionObserver's initial-callback-on-observe for an
          // intersecting sentinel is rejected by the guard below. Do not
          // move this block to a post-loadPage helper without preserving
          // that sequencing.
          observer = new IntersectionObserver(function(entries) {
            if (!entries[0].isIntersecting) return;
            if (isLoading || ctrl.signal.aborted) return;
            loadPage();
          }, { rootMargin: '200px' });
          observer.observe(sentinel);
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        if (observer) { observer.disconnect(); observer = null; }
        if (sentinel) {
          sentinel.textContent = 'Failed to load. Tap to retry.';
          sentinel.classList.add('music-error');
          sentinel.onclick = function() {
            sentinel.onclick = null;
            sentinel.textContent = 'Retrying...';
            // renderBrowse's first line is clear(r), which discards the
            // stale sentinel before a fresh paginate() attaches a new one.
            renderBrowse();
          };
        }
      } finally {
        isLoading = false;
      }
    }

    await loadPage();
  }

  // ---------- Browse view ----------

  async function renderBrowse() {
    var r = root(); clear(r);
    var crumbs = el('div', { className: 'music-crumbs' });
    var homeLink = el('a', { className: 'music-crumb', href: '#' }, 'Artists');
    homeLink.addEventListener('click', function(e) {
      e.preventDefault();
      state.browse = { level: 'artists', artistId: null, artistName: '', albumId: null, albumTitle: '', albumArtist: '' };
      renderBrowse();
    });
    crumbs.appendChild(homeLink);
    if (state.browse.level !== 'artists') {
      crumbs.appendChild(el('span', { className: 'music-crumb-sep' }, ' \\u203A '));
      var artistLink = el('a', { className: 'music-crumb', href: '#' }, state.browse.artistName || 'Artist');
      artistLink.addEventListener('click', function(e) {
        e.preventDefault();
        state.browse.level = 'albums';
        state.browse.albumId = null;
        renderBrowse();
      });
      crumbs.appendChild(artistLink);
    }
    if (state.browse.level === 'tracks') {
      crumbs.appendChild(el('span', { className: 'music-crumb-sep' }, ' \\u203A '));
      crumbs.appendChild(el('span', { className: 'music-crumb current' }, state.browse.albumTitle || 'Album'));
    }
    r.appendChild(crumbs);

    var loading = el('div', { className: 'music-loading' }, 'Loading...');
    r.appendChild(loading);

    try {
      if (state.browse.level === 'artists') await renderArtists(r, loading);
      else if (state.browse.level === 'albums') await renderAlbums(r, loading);
      else if (state.browse.level === 'tracks') await renderTracks(r, loading);
    } catch (err) {
      clear(loading);
      loading.textContent = 'Failed to load: ' + err.message;
      loading.classList.add('music-error');
    }
  }

  async function renderArtists(r, loading) {
    loading.remove();
    await paginate(r, '/api/funkwhale/browse/artists', 50, function(dest, rows, first, sentinel) {
      var list;
      if (first) {
        list = el('div', { className: 'music-list' });
        r.insertBefore(list, sentinel);
      } else {
        list = dest;
      }
      rows.forEach(function(a) {
        var row = el('div', { className: 'music-row music-row-clickable' });
        row.appendChild(el('div', { className: 'music-avatar' }, (a.name || '?').charAt(0).toUpperCase()));
        var meta = el('div', { className: 'music-row-meta' });
        meta.appendChild(el('div', { className: 'music-row-title' }, a.name));
        if (a.tracks_count) meta.appendChild(el('div', { className: 'music-row-sub' }, a.tracks_count + ' tracks'));
        row.appendChild(meta);
        row.addEventListener('click', function() {
          state.browse = { level: 'albums', artistId: a.id, artistName: a.name, albumId: null, albumTitle: '', albumArtist: '' };
          renderBrowse();
        });
        list.appendChild(row);
      });
      return list;
    });
  }

  async function renderAlbums(r, loading) {
    loading.remove();
    var url = '/api/funkwhale/browse/albums?artist=' + encodeURIComponent(state.browse.artistId);
    await paginate(r, url, 50, function(dest, rows, first, sentinel) {
      var grid;
      if (first) {
        grid = el('div', { className: 'music-album-grid' });
        r.insertBefore(grid, sentinel);
      } else {
        grid = dest;
      }
      rows.forEach(function(a) {
        var card = el('div', { className: 'music-album-card' });
        var cover = el('div', { className: 'music-album-cover' });
        if (a.artwork_url) {
          cover.style.backgroundImage = "url('/api/funkwhale/artwork?src=" + encodeURIComponent(a.artwork_url) + "')";
        } else {
          cover.textContent = (a.title || '?').charAt(0).toUpperCase();
          cover.classList.add('music-album-cover-placeholder');
        }
        card.appendChild(cover);
        card.appendChild(el('div', { className: 'music-album-title' }, a.title));
        if (a.year) card.appendChild(el('div', { className: 'music-album-sub' }, a.year));
        card.addEventListener('click', function() {
          state.browse = {
            level: 'tracks',
            artistId: state.browse.artistId,
            artistName: state.browse.artistName,
            albumId: a.id,
            albumTitle: a.title,
            albumArtist: a.artist || state.browse.artistName,
            albumArtwork: a.artwork_url,
          };
          renderBrowse();
        });
        grid.appendChild(card);
      });
      return grid;
    });
  }

  async function renderTracks(r, loading) {
    loading.remove();
    // Accumulator for Play All — grows across pages so Play-All dispatches
    // the entire album, not just the first 100 tracks.
    var allTracks = [];
    var url = '/api/funkwhale/browse/tracks?album=' + encodeURIComponent(state.browse.albumId);
    await paginate(r, url, 50, function(dest, rows, first, sentinel) {
      var list;
      if (first) {
        // Album header + Play All, then the track list. All direct children
        // of r so sentinel stays at the end of r below the list.
        var header = el('div', { className: 'music-album-header' });
        if (state.browse.albumArtwork) {
          var thumb = el('div', { className: 'music-album-cover-sm' });
          thumb.style.backgroundImage = "url('/api/funkwhale/artwork?src=" + encodeURIComponent(state.browse.albumArtwork) + "')";
          header.appendChild(thumb);
        }
        var info = el('div', { className: 'music-album-header-info' });
        info.appendChild(el('div', { className: 'music-album-header-title' }, state.browse.albumTitle));
        info.appendChild(el('div', { className: 'music-album-header-sub' }, state.browse.albumArtist));
        header.appendChild(info);
        var playAllBtn = el('button', { className: 'btn btn-primary btn-sm' }, '\u25B6 Play All');
        playAllBtn.addEventListener('click', function() { playAll(allTracks); });
        header.appendChild(playAllBtn);
        r.insertBefore(header, sentinel);
        list = el('div', { className: 'music-list' });
        r.insertBefore(list, sentinel);
      } else {
        list = dest;
      }
      rows.forEach(function(t) {
        allTracks.push(t);
        list.appendChild(renderTrackRow(t));
      });
      return list;
    });
  }

  // ---------- Recent view ----------

  async function renderRecent() {
    var r = root(); clear(r);
    var loading = el('div', { className: 'music-loading' }, 'Loading recent listens...');
    r.appendChild(loading);
    try {
      var res = await fetch('/api/funkwhale/listens?page_size=50', { credentials: 'same-origin' });
      var data = await res.json();
      loading.remove();
      if (!data.listens || data.listens.length === 0) {
        r.appendChild(el('div', { className: 'music-empty' }, 'No recent listens yet. Play something!'));
        return;
      }
      var list = el('div', { className: 'music-list' });
      data.listens.forEach(function(l) {
        var t = {
          uuid: l.track_uuid,
          title: l.track_title,
          artist: l.artist,
          album: l.album,
          artwork_url: l.artwork_url,
        };
        if (!t.uuid) return; // can't play without uuid
        list.appendChild(renderTrackRow(t));
      });
      r.appendChild(list);
    } catch (err) {
      loading.textContent = 'Failed: ' + err.message;
      loading.classList.add('music-error');
    }
  }

  // ---------- Search view ----------

  function onSearchInput(value) {
    state.searchQuery = value.trim();
    if (state.searchTimer) clearTimeout(state.searchTimer);
    if (state.searchQuery.length < 2) {
      if (state.view === 'search') renderSearchResults();
      return;
    }
    state.searchTimer = setTimeout(function() {
      if (state.view !== 'search') setView('search');
      else renderSearchResults();
    }, 300);
  }

  async function renderSearchResults() {
    var r = root(); clear(r);
    if (state.searchQuery.length < 2) {
      r.appendChild(el('div', { className: 'music-empty' }, 'Type at least 2 characters to search.'));
      return;
    }
    // Abort any in-flight
    if (state.searchAbort) { try { state.searchAbort.abort(); } catch (_) {} }
    var ctrl = new AbortController();
    state.searchAbort = ctrl;

    var loading = el('div', { className: 'music-loading' }, 'Searching...');
    r.appendChild(loading);

    try {
      var res = await fetch('/api/funkwhale/search?q=' + encodeURIComponent(state.searchQuery), { credentials: 'same-origin', signal: ctrl.signal });
      var data = await res.json();
      if (ctrl !== state.searchAbort) return; // newer search in flight
      loading.remove();

      var hasResults = (data.artists && data.artists.length) || (data.albums && data.albums.length) || (data.tracks && data.tracks.length);
      if (!hasResults) {
        r.appendChild(el('div', { className: 'music-empty' }, 'No results for "' + state.searchQuery + '"'));
        return;
      }

      if (data.artists && data.artists.length) {
        r.appendChild(el('h3', { className: 'music-section-title' }, 'Artists'));
        var alist = el('div', { className: 'music-list' });
        data.artists.forEach(function(a) {
          var row = el('div', { className: 'music-row music-row-clickable' });
          row.appendChild(el('div', { className: 'music-avatar' }, (a.name || '?').charAt(0).toUpperCase()));
          var m = el('div', { className: 'music-row-meta' });
          m.appendChild(el('div', { className: 'music-row-title' }, a.name));
          row.appendChild(m);
          row.addEventListener('click', function() {
            state.browse = { level: 'albums', artistId: a.id, artistName: a.name, albumId: null, albumTitle: '', albumArtist: '' };
            setView('browse');
          });
          alist.appendChild(row);
        });
        r.appendChild(alist);
      }

      if (data.albums && data.albums.length) {
        r.appendChild(el('h3', { className: 'music-section-title' }, 'Albums'));
        var albumList = el('div', { className: 'music-list' });
        data.albums.forEach(function(a) {
          var row = el('div', { className: 'music-row music-row-clickable' });
          if (a.artwork_url) {
            var thumb = el('div', { className: 'music-album-cover-xs' });
            thumb.style.backgroundImage = 'url(' + "'/api/funkwhale/artwork?src=" + encodeURIComponent(a.artwork_url) + "'" + ')';
            row.appendChild(thumb);
          } else {
            row.appendChild(el('div', { className: 'music-avatar' }, (a.title || '?').charAt(0).toUpperCase()));
          }
          var m = el('div', { className: 'music-row-meta' });
          m.appendChild(el('div', { className: 'music-row-title' }, a.title));
          if (a.artist) m.appendChild(el('div', { className: 'music-row-sub' }, a.artist));
          row.appendChild(m);
          row.addEventListener('click', function() {
            state.browse = {
              level: 'tracks',
              artistId: null,
              artistName: a.artist || '',
              albumId: a.id,
              albumTitle: a.title,
              albumArtist: a.artist || '',
              albumArtwork: a.artwork_url,
            };
            setView('browse');
          });
          albumList.appendChild(row);
        });
        r.appendChild(albumList);
      }

      if (data.tracks && data.tracks.length) {
        r.appendChild(el('h3', { className: 'music-section-title' }, 'Tracks'));
        var tlist = el('div', { className: 'music-list' });
        data.tracks.forEach(function(t) {
          if (t.uuid) tlist.appendChild(renderTrackRow(t));
        });
        r.appendChild(tlist);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      loading.textContent = 'Search failed: ' + err.message;
      loading.classList.add('music-error');
    }
  }

  // ---------- Track row + playback ----------

  function renderTrackRow(t) {
    var row = el('div', { className: 'music-row' });
    if (t.artwork_url) {
      var thumb = el('div', { className: 'music-album-cover-xs' });
      thumb.style.backgroundImage = 'url(' + "'/api/funkwhale/artwork?src=" + encodeURIComponent(t.artwork_url) + "'" + ')';
      row.appendChild(thumb);
    }
    var meta = el('div', { className: 'music-row-meta' });
    meta.appendChild(el('div', { className: 'music-row-title' }, t.title || 'Unknown'));
    var sub = [t.artist, t.album].filter(Boolean).join(' \\u2014 ');
    if (sub) meta.appendChild(el('div', { className: 'music-row-sub' }, sub));
    row.appendChild(meta);

    var actions = el('div', { className: 'music-row-actions' });
    var playBtn = el('button', { className: 'btn btn-sm btn-primary', title: 'Play' }, '\\u25B6');
    playBtn.addEventListener('click', function(ev) { ev.stopPropagation(); playTrack(t); });
    actions.appendChild(playBtn);

    // Play on Glasses button (only if glasses paired)
    var glassesId = window.crowPlayer && window.crowPlayer.getGlassesDeviceId && window.crowPlayer.getGlassesDeviceId();
    if (glassesId) {
      var glassesBtn = el('button', { className: 'btn btn-sm btn-secondary', title: 'Play on Glasses' }, '\\uD83D\\uDC53');
      glassesBtn.addEventListener('click', function(ev) { ev.stopPropagation(); playOnGlasses(t); });
      actions.appendChild(glassesBtn);
    }

    var queueBtn = el('button', { className: 'btn btn-sm btn-secondary', title: 'Add to queue' }, '+');
    queueBtn.addEventListener('click', function(ev) { ev.stopPropagation(); queueTrack(t); });
    actions.appendChild(queueBtn);

    row.appendChild(actions);
    return row;
  }

  function trackToItem(t) {
    return {
      src: '/api/funkwhale/stream/' + encodeURIComponent(t.uuid),
      title: t.title || 'Unknown',
      subtitle: t.artist || '',
      metadata: {
        title: t.title,
        artist: t.artist,
        album: t.album,
        artwork: t.artwork_url,
      },
    };
  }

  function playTrack(t) {
    if (!window.crowPlayer) return;
    var item = trackToItem(t);
    window.crowPlayer.load(item.src, item.title, item.subtitle, item.metadata);
  }

  function queueTrack(t) {
    if (!window.crowPlayer) return;
    window.crowPlayer.addToQueue(trackToItem(t));
    showToast('Queued: ' + (t.title || 'track'));
  }

  function playAll(tracks) {
    if (!window.crowPlayer) return;
    var items = tracks.filter(function(t) { return t.uuid; }).map(trackToItem);
    if (items.length === 0) return;
    window.crowPlayer.queue(items);
  }

  async function playOnGlasses(t) {
    var deviceId = window.crowPlayer && window.crowPlayer.getGlassesDeviceId && window.crowPlayer.getGlassesDeviceId();
    if (!deviceId) { showToast('No glasses paired'); return; }
    var body = {
      device_id: deviceId,
      url: (location.origin || '') + '/api/funkwhale/stream/' + encodeURIComponent(t.uuid) + '?to=mp3',
      codec: 'mp3',
      auth: 'funkwhale',
      title: t.title,
      artist: t.artist,
      artwork_url: t.artwork_url,
    };
    // Direct Funkwhale URL for the glasses push (server-side path, not browser path)
    body.url = (window.__FUNKWHALE_URL__ || '') || body.url;
    // For glasses we bypass the proxy and send the direct Funkwhale URL, because
    // pushAudioStream on the server-side can access Funkwhale directly with its token.
    // But we need the Funkwhale URL from somewhere. Fallback: ask the server.
    try {
      var fwInfo = await fetch('/api/funkwhale/status', { credentials: 'same-origin' }).then(function(r) { return r.json(); });
      if (fwInfo && fwInfo.hostname) {
        body.url = 'https://' + fwInfo.hostname + '/api/v1/listen/' + encodeURIComponent(t.uuid) + '/?to=mp3';
      }
    } catch (_) {}
    try {
      var res = await fetch('/api/meta-glasses/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      var data = await res.json();
      if (data && data.ok) showToast('Playing on glasses');
      else if (data && data.reason === 'lock_busy') showToast('Glasses busy - stop current playback first');
      else showToast('Failed: ' + (data.reason || data.error || 'unknown'));
    } catch (err) {
      showToast('Failed: ' + err.message);
    }
  }

  // ---------- Toast ----------

  var toastTimer = null;
  function showToast(msg) {
    var t = document.getElementById('music-toast');
    if (!t) {
      t = el('div', { id: 'music-toast', className: 'music-toast' });
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { t.classList.remove('show'); }, 3000);
  }

  // ---------- Init ----------

  (async function init() {
    var ok = await checkFunkwhale();
    if (!ok) { renderSetupCTA(); return; }

    // Wire tab buttons
    document.querySelectorAll('.music-tab').forEach(function(tab) {
      tab.addEventListener('click', function() { setView(tab.getAttribute('data-view')); });
    });

    // Wire search
    var searchInput = document.getElementById('music-search');
    if (searchInput) {
      searchInput.addEventListener('input', function(e) { onSearchInput(e.target.value); });
    }

    setView('browse');
  })();
})();
`;

function styles() {
  return `
    .music-panel { max-width: 900px; margin: 0 auto; padding: 0.5rem; }
    .music-topbar {
      display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0;
      position: sticky; top: 0; background: var(--crow-bg-surface);
      z-index: 10; border-bottom: 1px solid var(--crow-border);
    }
    .music-tabs { display: flex; gap: 0.25rem; }
    .music-tab {
      background: none; border: 1px solid var(--crow-border); color: var(--crow-text);
      border-radius: 20px; padding: 0.3rem 0.8rem; font-size: 0.85rem; cursor: pointer;
    }
    .music-tab.active { background: var(--crow-accent); color: white; border-color: var(--crow-accent); }
    .music-search {
      flex: 1; padding: 0.4rem 0.75rem; background: var(--crow-bg-elevated);
      border: 1px solid var(--crow-border); border-radius: 6px; color: var(--crow-text);
      font-size: 0.9rem;
    }

    .music-crumbs { padding: 0.5rem 0; font-size: 0.85rem; color: var(--crow-text-muted); }
    .music-crumb { color: var(--crow-accent); text-decoration: none; }
    .music-crumb.current { color: var(--crow-text); font-weight: 500; }
    .music-crumb-sep { margin: 0 0.25rem; color: var(--crow-text-muted); }

    .music-loading, .music-empty { padding: 2rem 1rem; text-align: center; color: var(--crow-text-muted); }
    .music-empty h2 { margin: 0 0 0.5rem; }
    .music-error { color: var(--crow-error); }

    .music-list { display: flex; flex-direction: column; gap: 0.25rem; }
    .music-row {
      display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem;
      background: var(--crow-bg-surface); border-radius: 6px;
    }
    .music-row-clickable { cursor: pointer; }
    .music-row-clickable:hover { background: var(--crow-bg-elevated); }

    .music-avatar {
      width: 40px; height: 40px; border-radius: 50%;
      background: var(--crow-bg-elevated); color: var(--crow-accent);
      display: flex; align-items: center; justify-content: center;
      font-weight: 600; font-size: 1rem; flex-shrink: 0;
    }
    .music-album-cover-xs {
      width: 40px; height: 40px; border-radius: 4px;
      background-size: cover; background-position: center;
      background-color: var(--crow-bg-elevated); flex-shrink: 0;
    }
    .music-album-cover-sm {
      width: 80px; height: 80px; border-radius: 6px;
      background-size: cover; background-position: center;
      background-color: var(--crow-bg-elevated); flex-shrink: 0;
    }

    .music-row-meta { flex: 1; min-width: 0; }
    .music-row-title {
      font-size: 0.9rem; font-weight: 500;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .music-row-sub {
      font-size: 0.75rem; color: var(--crow-text-muted);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    .music-row-actions { display: flex; gap: 0.25rem; flex-shrink: 0; }
    .music-row-actions .btn { min-width: 32px; padding: 0.25rem 0.5rem; }

    .music-album-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 0.75rem; padding: 0.5rem 0;
    }
    .music-album-card { cursor: pointer; }
    .music-album-cover {
      aspect-ratio: 1; border-radius: 6px;
      background-size: cover; background-position: center;
      background-color: var(--crow-bg-elevated);
      display: flex; align-items: center; justify-content: center;
      font-size: 2rem; font-weight: 600; color: var(--crow-accent);
    }
    .music-album-title {
      font-size: 0.85rem; font-weight: 500; margin-top: 0.35rem;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .music-album-sub { font-size: 0.75rem; color: var(--crow-text-muted); }

    .music-album-header {
      display: flex; align-items: center; gap: 0.75rem; padding: 1rem 0.5rem;
      border-bottom: 1px solid var(--crow-border); margin-bottom: 0.5rem;
    }
    .music-album-header-info { flex: 1; min-width: 0; }
    .music-album-header-title { font-size: 1.1rem; font-weight: 600; }
    .music-album-header-sub { font-size: 0.85rem; color: var(--crow-text-muted); }

    .music-section-title {
      font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--crow-text-muted); margin: 1rem 0 0.5rem; padding: 0 0.5rem;
    }

    .music-toast {
      position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
      background: var(--crow-bg-elevated); color: var(--crow-text);
      padding: 0.6rem 1rem; border-radius: 20px; font-size: 0.85rem;
      box-shadow: 0 2px 12px rgba(0,0,0,0.25); opacity: 0;
      transition: opacity 0.2s ease-in-out; pointer-events: none; z-index: 2000;
    }
    .music-toast.show { opacity: 1; }

    @media (max-width: 640px) {
      .music-album-grid { grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 0.5rem; }
      .music-row-actions .btn { min-width: 28px; padding: 0.2rem 0.4rem; font-size: 0.8rem; }
    }
  `;
}

export default {
  id: "music",
  name: "Music",
  icon: "music",
  route: "/dashboard/music",
  navOrder: 45,
  category: "media",

  async handler(req, res, { layout }) {
    const content = `
      <style>${styles()}</style>
      <div class="music-panel">
        <div class="music-topbar">
          <div class="music-tabs">
            <button class="music-tab active" data-view="browse">Browse</button>
            <button class="music-tab" data-view="recent">Recent</button>
            <button class="music-tab" data-view="search">Search</button>
          </div>
          <input id="music-search" class="music-search" placeholder="Search artists, albums, tracks..." autocomplete="off" />
        </div>
        <div id="music-root"></div>
      </div>
      <script>${CLIENT_SCRIPT}<\/script>
    `;
    res.send(layout({ title: "Music", content }));
  },
};
