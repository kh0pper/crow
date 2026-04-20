/**
 * Nest Panel — Client-Side JavaScript
 *
 * - Pin/unpin interactions (form auto-submits; no JS needed today).
 * - Unified carousel hash-driven active tab + keyboard nav + swipe/tap.
 */

export function nestClientJS(lang) {
  return `<script>
(function() {
  if (window.__crowNestInit) return;
  window.__crowNestInit = true;

  var SCROLL_SUPPRESS_MS = 200;
  var SWIPE_PX = 10;

  function tabsEl() { return document.getElementById('crow-instance-tabs'); }
  function carouselEl() { return document.querySelector('.nest-instance-carousel'); }

  function parseHashInstance() {
    var m = location.hash.match(/^#i\\/([a-zA-Z0-9_-]+)$/);
    return m ? m[1] : null;
  }

  function applyHashState() {
    var target = parseHashInstance() || 'local';
    var tabs = tabsEl();
    var carousel = carouselEl();
    if (!tabs) return;

    var activated = false;
    var tabEls = tabs.querySelectorAll('.crow-instance-tab');
    tabEls.forEach(function(a) {
      var id = a.getAttribute('data-instance-id') || 'local';
      var isActive = id === target;
      a.classList.toggle('active', isActive);
      if (a.getAttribute('role') === 'tab') {
        a.setAttribute('aria-selected', isActive ? 'true' : 'false');
        a.setAttribute('tabindex', isActive ? '0' : '-1');
      }
      if (isActive) activated = true;
    });

    if (carousel) {
      var section = carousel.querySelector('[data-instance="' + target + '"]');
      if (section && typeof section.scrollIntoView === 'function') {
        section.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'start' });
      }
    }

    if (!activated) {
      var firstTab = tabs.querySelector('.crow-instance-tab');
      if (firstTab) firstTab.classList.add('active');
    }
  }

  function nextEnabledTab(current, dir) {
    var tabs = Array.prototype.slice.call(
      tabsEl().querySelectorAll('.crow-instance-tab')
    );
    var idx = tabs.indexOf(current);
    if (idx < 0) return null;
    for (var step = 1; step < tabs.length; step++) {
      var next = tabs[(idx + dir * step + tabs.length) % tabs.length];
      if (next.getAttribute('aria-disabled') !== 'true') return next;
    }
    return null;
  }

  function onKeydown(e) {
    var tabs = tabsEl();
    if (!tabs) return;
    if (!tabs.contains(document.activeElement)) return;
    if (document.activeElement.getAttribute('role') !== 'tab') return;

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      var r = nextEnabledTab(document.activeElement, +1);
      if (r) { r.focus(); r.click(); }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      var l = nextEnabledTab(document.activeElement, -1);
      if (l) { l.focus(); l.click(); }
    } else if (e.key === 'Home') {
      e.preventDefault();
      var first = tabs.querySelector('.crow-instance-tab:not([aria-disabled="true"])');
      if (first) { first.focus(); first.click(); }
    } else if (e.key === 'End') {
      e.preventDefault();
      var all = tabs.querySelectorAll('.crow-instance-tab:not([aria-disabled="true"])');
      var last = all[all.length - 1];
      if (last) { last.focus(); last.click(); }
    }
  }

  var _pointer = null;
  var _scrollTs = 0;

  function onPointerDown(e) {
    _pointer = { x: e.clientX, y: e.clientY, t: Date.now() };
  }
  function onPointerUp(e) {
    if (!_pointer) return;
    var dx = e.clientX - _pointer.x;
    if (Math.abs(dx) > SWIPE_PX) {
      _scrollTs = Date.now();
    }
    _pointer = null;
  }
  function onClickCapture(e) {
    if (Date.now() - _scrollTs < SCROLL_SUPPRESS_MS) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  function onRetryClick(e) {
    var btn = e.target.closest('.nest-instance-retry');
    if (!btn) return;
    btn.textContent = '…';
    btn.disabled = true;
    setTimeout(function() { location.reload(); }, 50);
  }

  function wireTabs() {
    var tabs = tabsEl();
    if (!tabs || tabs.__crowWired) return;
    tabs.__crowWired = true;

    tabs.addEventListener('click', function(e) {
      var a = e.target.closest('.crow-instance-tab');
      if (!a) return;
      // ALWAYS preventDefault. Turbo has an aggressive document-level
      // click listener that sometimes swallows <a> clicks even when
      // data-turbo="false" is set — the imperative path is the reliable
      // one.
      e.preventDefault();
      e.stopPropagation();

      var id = a.getAttribute('data-instance-id');
      if (!id) return;

      // Offline / aria-disabled tabs still scroll the carousel to their
      // offline-placeholder section (where the Retry button lives). The
      // visual "disabled" cue stays via CSS — only keyboard-Tab ordering
      // skips the tab via tabindex=-1 (handled server-side).
      var newHash = id === 'local' ? '' : '#i/' + id;
      var newUrl = location.pathname + location.search + newHash;
      if (location.hash !== newHash) {
        try { history.pushState(null, '', newUrl); } catch (err) { /* cross-origin or restricted: ignore */ }
      }
      applyHashState();
    });

    document.addEventListener('keydown', onKeydown);

    var carousel = carouselEl();
    if (carousel) {
      carousel.addEventListener('pointerdown', onPointerDown, true);
      carousel.addEventListener('pointerup', onPointerUp, true);
      carousel.addEventListener('click', onClickCapture, true);
      carousel.addEventListener('click', onRetryClick);
      var scrollTimer = null;
      carousel.addEventListener('scroll', function() {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(function() {
          syncHashFromScroll();
        }, 80);
      });
    }
  }

  function syncHashFromScroll() {
    var carousel = carouselEl();
    if (!carousel) return;
    var sections = carousel.querySelectorAll('.nest-instance-section');
    var mid = carousel.scrollLeft + carousel.clientWidth / 2;
    var best = null;
    for (var i = 0; i < sections.length; i++) {
      var s = sections[i];
      var l = s.offsetLeft, r = l + s.offsetWidth;
      if (mid >= l && mid < r) { best = s; break; }
    }
    if (!best) return;
    var id = best.getAttribute('data-instance') || 'local';
    var newHash = id === 'local' ? '' : '#i/' + id;
    if (location.hash !== newHash) {
      history.replaceState(null, '', location.pathname + location.search + newHash);
      var tabs = tabsEl();
      if (tabs) {
        tabs.querySelectorAll('.crow-instance-tab').forEach(function(a) {
          var isActive = (a.getAttribute('data-instance-id') || 'local') === id;
          a.classList.toggle('active', isActive);
          if (a.getAttribute('role') === 'tab') {
            a.setAttribute('aria-selected', isActive ? 'true' : 'false');
            a.setAttribute('tabindex', isActive ? '0' : '-1');
          }
        });
      }
    }
  }

  window.addEventListener('hashchange', applyHashState);
  document.addEventListener('turbo:load', function() {
    wireTabs();
    applyHashState();
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { wireTabs(); applyHashState(); });
  } else {
    wireTabs();
    applyHashState();
  }
})();
</script>`;
}
