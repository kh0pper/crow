/**
 * The grid's client (widgets phase 2, spec §7.3): the device's own layout, applied without a server
 * round trip, and the Edit mode that changes it.
 *
 * Where the layout lives: `localStorage["crow.widgets.layout.<page>"]`, the spec's stated fallback
 * for a per-device layout (a browser has no device key). Never synced, never sent anywhere. The
 * stored value is `{ v: 1, cells: [{ id, w, h }] }`, in the order the cells are shown; a widget that
 * is not listed has been removed on THIS device.
 *
 * What it does:
 *   - on load: applies the stored order, size and removals. Anything odd — no value, broken JSON, a
 *     wrong version, an id no widget carries any more — falls back to the server's default, never to
 *     a blank page;
 *   - fills a LAZY cell the first moment this device shows it: a widget the page offers but its own
 *     default layout does not hold is drawn by the server as a hidden cell with one loading line
 *     (`data-wg-lazy="1"`), and its body is fetched from GET /dashboard/widgets-api/cell on this
 *     page. An empty answer is the grid's "nothing to show" line, a failed one its error line (and
 *     the cell is marked lazy again, so a later show tries once more);
 *   - Edit: shows Remove on each cell and a Size button that steps through the sizes that widget is
 *     allowed (`data-sizes`) and nothing else. Pointer events move a cell: the mouse drags at once,
 *     a touch starts after a long press, so a scroll or the shell's swipe is never mistaken for a
 *     drag. "+ Add widget" lists the widgets this device removed, and Done writes the layout.
 *
 * The script is emitted inside a template literal (like For You's own client), so this source may
 * carry NO backtick and no "${": it is ES5-style on purpose.
 */
export function gridClientJs() {
  return `<script>
(function () {
  var STORE = 'crow.widgets.layout.';
  var LONG_PRESS_MS = 400;
  var SLOP = 8;

  function num(value) {
    var n = Number(value);
    return isFinite(n) ? n : 0;
  }
  function parse(text) {
    try { return JSON.parse(text); } catch (err) { return null; }
  }
  function isList(value) {
    return Object.prototype.toString.call(value) === '[object Array]';
  }
  function show(el) { if (el) el.removeAttribute('hidden'); }
  function hide(el) { if (el) el.setAttribute('hidden', ''); }
  function hiddenOf(el) { return !!(el && el.hasAttribute && el.hasAttribute('hidden')); }

  function bind(grid) {
    if (!grid || grid.getAttribute('data-wg-ready') === '1') return;
    grid.setAttribute('data-wg-ready', '1');

    var key = STORE + (grid.getAttribute('data-wg-page') || '');
    var editBtn = grid.querySelector('[data-wg-edit]');
    var addBtn = grid.querySelector('[data-wg-add]');
    var doneBtn = grid.querySelector('[data-wg-done]');
    var hint = grid.querySelector('[data-wg-hint]');
    var status = grid.querySelector('[data-wg-status]');
    var editing = false;
    var drag = null;
    var picker = null;
    // The order the server drew, kept so a Turbo snapshot can be put back to it: edit-mode changes
    // are only kept when Done was pressed.
    var serverOrder = cells();

    function cells() {
      var out = [];
      var list = grid.querySelectorAll('[data-widget]');
      for (var i = 0; i < list.length; i++) out.push(list[i]);
      return out;
    }
    function cellById(id) {
      var want = String(id == null ? '' : id);
      var list = cells();
      for (var i = 0; i < list.length; i++) {
        if (list[i].getAttribute('data-widget') === want) return list[i];
      }
      return null;
    }
    function shown() {
      var out = [];
      var list = cells();
      for (var i = 0; i < list.length; i++) if (!hiddenOf(list[i])) out.push(list[i]);
      return out;
    }
    function sizesOf(cell) {
      var list = parse(cell.getAttribute('data-sizes'));
      var out = [];
      if (!isList(list)) return out;
      for (var i = 0; i < list.length; i++) {
        if (isList(list[i]) && list[i].length >= 2) out.push([num(list[i][0]), num(list[i][1])]);
      }
      return out;
    }
    function defaultSize(cell) {
      var parts = String(cell.getAttribute('data-def') || '').split(',');
      var w = num(parts[0]);
      var h = num(parts[1]);
      if (!w || !h) {
        var list = sizesOf(cell);
        return list.length ? list[0] : [2, 1];
      }
      return [w, h];
    }
    function putSize(cell, w, h) {
      var list = sizesOf(cell);
      var pick = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i][0] === num(w) && list[i][1] === num(h)) { pick = list[i]; break; }
      }
      if (!pick) pick = defaultSize(cell);
      cell.setAttribute('data-w', String(pick[0]));
      cell.setAttribute('data-h', String(pick[1]));
      return pick;
    }
    // The next size in the widget's own list, wrapping. A size that is not in the list starts the
    // cycle over at its first entry, so the handle never invents a size.
    function cycleSize(cell) {
      var list = sizesOf(cell);
      if (!list.length) return null;
      var w = num(cell.getAttribute('data-w'));
      var h = num(cell.getAttribute('data-h'));
      var at = -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i][0] === w && list[i][1] === h) { at = i; break; }
      }
      var next = list[(at + 1) % list.length];
      return putSize(cell, next[0], next[1]);
    }

    // ---- a lazy cell's body ----

    // The grid carries the two lines the client may have to draw itself: the server's "nothing to
    // show" and its "couldn't load". Both are page text, so they go in as text, never as markup.
    function bodyOf(cell) { return cell.querySelector('.wg-cell-body'); }
    function setNote(cell, text) {
      var body = bodyOf(cell);
      if (!body) return;
      body.textContent = '';
      var p = document.createElement('p');
      p.className = 'fy-note';
      p.textContent = text;
      body.appendChild(p);
    }
    function fillLazy(cell) {
      if (!cell || !grid.contains(cell)) return;
      // '1' is "not fetched yet"; 'loading' is "a fetch is on its way" (so a second show cannot
      // start a second one). A fetched cell carries no attribute at all.
      if (cell.getAttribute('data-wg-lazy') !== '1') return;
      if (hiddenOf(cell)) return;
      var id = cell.getAttribute('data-widget');
      if (!id) return;
      var page = grid.getAttribute('data-wg-page') || '';
      cell.setAttribute('data-wg-lazy', 'loading');
      function failed() {
        setNote(cell, grid.getAttribute('data-wg-error') || '');
        cell.setAttribute('data-wg-lazy', '1');
      }
      if (typeof window.fetch !== 'function') { failed(); return; }
      var url = '/dashboard/widgets-api/cell?page=' + encodeURIComponent(page) + '&id=' + encodeURIComponent(id);
      var request;
      try {
        request = window.fetch(url, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } });
      } catch (err) { failed(); return; }
      Promise.resolve(request).then(function (res) {
        if (!res || !res.ok) throw new Error('cell request refused');
        return res.json();
      }).then(function (data) {
        if (!data || typeof data.html !== 'string') throw new Error('cell request answered oddly');
        var body = bodyOf(cell);
        if (!body) throw new Error('cell has no body');
        if (data.html) body.innerHTML = data.html;
        else setNote(cell, grid.getAttribute('data-wg-nothing') || '');
        cell.removeAttribute('data-wg-lazy');
      }).catch(function () { failed(); });
    }
    function fillShownLazy() {
      var list = shown();
      for (var i = 0; i < list.length; i++) fillLazy(list[i]);
    }

    // ---- the device's layout ----

    // A saved layout lists what this device shows; anything not listed stays hidden here, including
    // a widget registered later or a section switched back on in the customize screen. That is the
    // plan's choice (no surprise additions to a page someone arranged); "+ Add widget" offers them.
    function readLayout() {
      var raw = null;
      try { raw = window.localStorage.getItem(key); } catch (err) { return null; }
      if (!raw) return null;
      var stored = parse(raw);
      if (!stored || num(stored.v) !== 1 || !isList(stored.cells)) return null;
      if (!stored.cells.length) return [];          // every widget removed: a real layout
      var out = [];
      for (var i = 0; i < stored.cells.length; i++) {
        var entry = stored.cells[i];
        if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
        if (!cellById(entry.id)) continue;          // no widget carries this id any more
        out.push({ id: entry.id, w: num(entry.w), h: num(entry.h) });
      }
      // A layout whose every id is gone is a layout from another Crow, not "remove everything":
      // the default is safer than a blank page.
      return out.length ? out : null;
    }

    function applyLayout(layout) {
      var list = cells();
      var i;
      if (!layout) {
        // No layout of its own: exactly what the server drew. A cell the server drew hidden (the
        // weather: offered, not part of the page's default) stays hidden until this device adds it.
        for (i = 0; i < list.length; i++) {
          var size = defaultSize(list[i]);
          putSize(list[i], size[0], size[1]);
        }
        return;
      }
      for (i = 0; i < list.length; i++) hide(list[i]);
      for (i = 0; i < layout.length; i++) {
        var cell = cellById(layout[i].id);
        if (!cell) continue;
        show(cell);
        putSize(cell, layout[i].w, layout[i].h);
        grid.appendChild(cell);
      }
    }

    function save() {
      var layout = { v: 1, cells: [] };
      var list = shown();
      for (var i = 0; i < list.length; i++) {
        layout.cells.push({
          id: list[i].getAttribute('data-widget'),
          w: num(list[i].getAttribute('data-w')),
          h: num(list[i].getAttribute('data-h'))
        });
      }
      try { window.localStorage.setItem(key, JSON.stringify(layout)); } catch (err) { /* private mode: still works now */ }
      if (status) status.textContent = grid.getAttribute('data-wg-saved') || '';
      return layout;
    }

    // ---- edit mode ----

    function setEditing(on) {
      editing = !!on;
      if (editing) grid.setAttribute('data-editing', '');
      else grid.removeAttribute('data-editing');
      if (editing) {
        hide(editBtn); show(addBtn); show(doneBtn); show(hint);
      } else {
        show(editBtn); hide(addBtn); hide(doneBtn); hide(hint);
      }
      if (!editing) stopDrag();
      // Focus never stays on a button that has just been hidden.
      var next = editing ? doneBtn : editBtn;
      try { if (next && typeof next.focus === 'function') next.focus(); } catch (err) { /* no focus here */ }
    }

    /** Back to the server's drawing plus the device's saved layout: unsaved edits are dropped. */
    function reset() {
      for (var i = 0; i < serverOrder.length; i++) grid.appendChild(serverOrder[i]);
      applyLayout(readLayout());
    }

    // ---- moving a cell ----

    function rectOf(cell) {
      if (typeof cell.getBoundingClientRect !== 'function') return null;
      return cell.getBoundingClientRect();
    }
    function cellAt(x, y, except) {
      var list = shown();
      for (var i = 0; i < list.length; i++) {
        if (list[i] === except) continue;
        var r = rectOf(list[i]);
        if (!r) continue;
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return list[i];
      }
      return null;
    }
    function stopDrag() {
      if (!drag) return;
      if (drag.timer) { clearTimeout(drag.timer); drag.timer = null; }
      if (drag.cell) drag.cell.removeAttribute('data-wg-dragging');
      grid.removeAttribute('data-wg-dragging');
      drag = null;
    }
    function startDrag() {
      if (!drag || !drag.cell) return;
      drag.timer = null;
      drag.moving = true;
      grid.setAttribute('data-wg-dragging', '');
      drag.cell.setAttribute('data-wg-dragging', '');
      try {
        if (drag.cell.setPointerCapture && drag.pointerId != null) drag.cell.setPointerCapture(drag.pointerId);
      } catch (err) { /* no capture: the listeners on the grid still see the moves */ }
    }
    function onDown(ev) {
      if (!editing || !ev) return;
      if (ev.button != null && ev.button !== 0) return;
      var target = ev.target;
      if (!target || !target.closest) return;
      if (target.closest('[data-wg-remove]') || target.closest('[data-wg-size]')) return;
      var cell = target.closest('[data-widget]');
      if (!cell || !grid.contains(cell)) return;
      stopDrag();
      var touch = ev.pointerType === 'touch' || ev.pointerType === 'pen';
      drag = {
        cell: cell, x: num(ev.clientX), y: num(ev.clientY),
        pointerId: ev.pointerId == null ? null : ev.pointerId, moving: false, timer: null
      };
      if (touch) {
        drag.timer = setTimeout(startDrag, LONG_PRESS_MS);
      } else {
        startDrag();
      }
    }
    function onMove(ev) {
      if (!drag || !ev) return;
      var x = num(ev.clientX);
      var y = num(ev.clientY);
      if (!drag.moving) {
        var dx = x - drag.x;
        var dy = y - drag.y;
        // Moved before the long press landed: a scroll or a sideways gesture, not a drag.
        if (dx * dx + dy * dy > SLOP * SLOP) stopDrag();
        return;
      }
      if (ev.cancelable && typeof ev.preventDefault === 'function') ev.preventDefault();
      var over = cellAt(x, y, drag.cell);
      if (!over) return;
      var r = rectOf(over);
      if (!r) return;
      // Dropped on the near (top-left) half of a cell: go before it. The far half: after it.
      var before = (x - r.left) + (y - r.top) < (r.right - x) + (r.bottom - y);
      if (before) {
        if (over.previousSibling !== drag.cell) grid.insertBefore(drag.cell, over);
      } else if (over.nextSibling !== drag.cell) {
        grid.insertBefore(drag.cell, over.nextSibling);
      }
    }
    function onUp() { stopDrag(); }

    // ---- the picker ----

    function pickerNode() {
      if (picker) return picker;
      var tpl = grid.querySelector('[data-wg-picker-tpl]') || document.querySelector('[data-wg-picker-tpl]');
      if (!tpl || !tpl.content || typeof document.importNode !== 'function') return null;
      var node = document.importNode(tpl.content, true).firstElementChild;
      if (!node) return null;
      picker = node;
      document.body.appendChild(picker);
      picker.addEventListener('click', onPickerClick);
      return picker;
    }
    function refreshPicker() {
      var buttons = picker.querySelectorAll('[data-wg-add]');
      var offered = 0;
      for (var i = 0; i < buttons.length; i++) {
        var cell = cellById(buttons[i].getAttribute('data-wg-add'));
        if (cell && !hiddenOf(cell)) {
          hide(buttons[i]);
        } else {
          show(buttons[i]);
          offered++;
        }
      }
      var empty = picker.querySelector('[data-wg-picker-empty]');
      if (empty) {
        if (offered) hide(empty); else show(empty);
      }
    }
    function openPicker() {
      if (!pickerNode()) return;
      refreshPicker();
      if (typeof picker.showModal === 'function') picker.showModal();
      else picker.setAttribute('open', '');
    }
    function closePicker() {
      if (!picker) return;
      if (typeof picker.close === 'function') picker.close();
      else picker.removeAttribute('open');
    }
    function onPickerClick(ev) {
      var target = ev && ev.target;
      if (!target || !target.closest) return;
      if (target.closest('[data-wg-picker-close]')) { closePicker(); return; }
      var add = target.closest('[data-wg-add]');
      if (!add) return;
      var cell = cellById(add.getAttribute('data-wg-add'));
      if (cell) {
        var size = defaultSize(cell);
        putSize(cell, size[0], size[1]);
        show(cell);
        grid.appendChild(cell);
        fillLazy(cell);
      }
      closePicker();
    }

    // ---- wiring ----

    grid.addEventListener('click', function (ev) {
      var target = ev && ev.target;
      if (!target || !target.closest) return;
      if (target.closest('[data-wg-edit]')) { setEditing(true); return; }
      if (target.closest('[data-wg-done]')) { save(); setEditing(false); return; }
      if (target.closest('[data-wg-add]')) { openPicker(); return; }
      var remove = target.closest('[data-wg-remove]');
      if (remove) {
        var gone = remove.closest('[data-widget]');
        if (gone) hide(gone);
        return;
      }
      var resize = target.closest('[data-wg-size]');
      if (resize) {
        var cell = resize.closest('[data-widget]');
        if (cell) cycleSize(cell);
      }
    });
    grid.addEventListener('pointerdown', onDown);
    grid.addEventListener('pointermove', onMove);
    grid.addEventListener('pointerup', onUp);
    grid.addEventListener('pointercancel', onUp);
    // A touch that has become a drag must not scroll the page under the finger. Before the long
    // press there is no drag, so the touchmove is left alone and the page scrolls as usual.
    grid.addEventListener('touchmove', function (ev) {
      if (drag && drag.moving && ev && ev.cancelable && typeof ev.preventDefault === 'function') ev.preventDefault();
    }, { passive: false });
    // A touch that starts on a cell while editing belongs to the grid: the shell's page swipe listens
    // on the document, so it never sees this one.
    grid.addEventListener('touchstart', function (ev) {
      if (editing && ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
    }, { passive: true });

    // Turbo caches the page as it is. A snapshot taken mid-edit would come back with a stuck Edit
    // mode and changes nobody confirmed, so the grid is put back before the snapshot is taken. The
    // visit's grid must be one more entry, not one more listener.
    var tidies = window.__crowWidgetsGridTidies || (window.__crowWidgetsGridTidies = []);
    tidies.push(function () {
      if (grid.isConnected === false) return false;
      if (editing) setEditing(false);
      stopDrag();
      if (picker && picker.hasAttribute('open')) {
        try { if (typeof picker.close === 'function') picker.close(); } catch (err) { /* already closed */ }
      }
      reset();
      return true;
    });
    if (!window.__crowWidgetsGridCacheBound) {
      window.__crowWidgetsGridCacheBound = true;
      document.addEventListener('turbo:before-cache', function () {
        var kept = [];
        for (var i = 0; i < tidies.length; i++) if (tidies[i]()) kept.push(tidies[i]);
        tidies.length = 0;
        for (var j = 0; j < kept.length; j++) tidies.push(kept[j]);
      });
    }

    applyLayout(readLayout());
    fillShownLazy();
  }

  function boot() {
    var grids = document.querySelectorAll('.wg-grid[data-wg-page]');
    for (var i = 0; i < grids.length; i++) bind(grids[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
</script>`;
}