/**
 * Crow Mail's reader client script (plan 2, Task 8). It does only what a plain link cannot:
 *
 *   Frames. The page never carries a message body, and it never carries an iframe either: each
 *   conversation section carries a frame slot, and this script builds the frame from it — at bind
 *   time for a section that is open and the first time a closed one is opened. The sandbox is taken
 *   from the slot's own value and set BEFORE the src, and it is used only when it is exactly the
 *   server's own sandbox value (any other value, one differing only in case included, leaves the
 *   slot empty). Every load gets a fresh nonce in the URL's fragment (`#n=`), never sent to the
 *   server, plus the same nonce on the frame for the reply to check.
 *   The frame's own pinned helper posts its height and blocked-image count once. One listener on the
 *   window accepts a report only from that frame's own contentWindow, from the opaque origin such a
 *   frame reports (`"null"`) and with that frame's nonce; it floors and clamps the height, shows the
 *   image banner for a count above zero and writes the banner's own sentence for that count into a
 *   status line inside it (its singular for exactly one, its plural otherwise, the integer put into
 *   the sentence the server drew), taking both the line and the banner away for a count of 0. It
 *   never reads the frame's document: the frame is an opaque origin by design.
 *   Show images rebuilds this one frame with `images=1` (this view only, nothing stored); Always show
 *   posts the sender to the allow list first, then rebuilds it the same way.
 *
 *   Actions. The opened message's bar posts read/unread, archive, delete and move to the mail API for
 *   the row the bar names, one action at a time (every control waits for the answer, so a double tap
 *   is one intention). The bar draws both read controls and shows one of them, so an answer — from a
 *   click or from the automatic mark-read below — swaps them: Mark read goes away and Mark unread
 *   takes its place, or the other way round. Mark unread also says its own sentence in the bar, which
 *   the page drew into the bar's data attribute; Mark read shows nothing, because the plan approved no
 *   sentence for it. Archive, delete and move send the reader back to the list the page's own back
 *   link names, carrying the action's own note in the URL's `flash` (a move names the folder by id
 *   only), and from the moment the server agrees the bar stays disabled, because the page is on its
 *   way out and a control that came back to life could send a second action for a message that has
 *   already moved. Only a failure frees the bar again. An unread message is
 *   marked read once, 1.5 s after the page is shown, and only while the page is visible: the page's GET
 *   writes nothing, so a prefetch marks nothing read. A failure shows the fixed sentence for its code
 *   and stays; a success swaps the read controls and shows nothing more.
 *
 *   Refresh. The refresh control and a pull down of 80 px or more at the top of the list (the pull is
 *   bound on the list element alone) post one sync per account, then reload through Turbo. One round
 *   runs at a time: the control is disabled while it does, and a second trigger — another pull, or a
 *   click during the pull — is ignored, so the accounts are never synced twice over. Look further
 *   back continues each listed folder's history on the server, and the server search asks the
 *   accounts' servers; both reload with a `flash` the panel reads back into a sentence.
 *
 *   Settings. Rename and the local-models switch PATCH their own field, Update password PUTs the new
 *   secret, the add-account form posts its fields as the connect body to the accounts route this
 *   script hardcodes, Remove sender deletes one allowance, and Remove account keeps its sentence
 *   hidden until the first click and deletes the account only on a later click at least 500 ms after
 *   that; the confirmation lapses after 8 s or when focus leaves the block.
 *   The add-account form is the one form here that must never reach the browser, so its listener is
 *   bound on the form itself and cancels the submit as its very first act, before it looks at the
 *   event or reads a field. The header's search box is a plain GET form and is left alone: it must
 *   search with no script at all.
 *
 * Every sentence comes from the page: the panel renders one hidden element carrying the fixed
 * sentence for each API error code (data-ml-err-<code>, lower-cased before the lookup, because the
 * mail API answers both a code's own spelling and its upper-case form), and the refresh control
 * carries the word its status line shows. A code with no sentence of its own shows the element's
 * generic sentence instead, and a failure that carries no code at all (a network error with no
 * answer) is still the network sentence. Nothing here is built in JavaScript but nodes and text.
 *
 * Lifecycle: Turbo re-runs this script on every visit. Listeners on an element inside the panel are
 * bound behind a marker on that element (the element is replaced with the page, so a fresh one binds
 * again); the window's message listener and the document's turbo:before-visit hook are bound once
 * per window, and so is the window's pagehide hook. The mark-read timer a later part of the plan arms
 * lives in window.__mlTimer, which every run, every departure and every pagehide clears, so a timer
 * armed on one page can never fire on the next.
 *
 * Emitted inside a template literal: no backticks, no dollar-brace, no markup sink, and a backslash
 * in the emitted script is written doubled here. The stylesheet is scoped under .ml, so the one rule
 * that must name the document (Chrome Android's own pull-to-refresh would otherwise fire as well) is
 * injected by this script instead.
 */
import { FRAME_IFRAME_SANDBOX } from "../../../mail/reader/frame-doc.js";

export function mailClientJs(lang = "en") {
  // `lang` is here for the panel's uniform view signature: every word this script can show is a
  // data-ml-* attribute the server already translated.
  void lang;
  // The sandbox a slot's value is compared against is the server's own constant, written into the
  // script as a JSON string. It is substituted after the template rather than interpolated inside
  // it: the pin test reads this template literal as the script, and that script may hold neither a
  // backtick nor a dollar-brace.
  return `<script>
(function () {
  function clearMarkTimer() {
    if (window.__mlTimer) {
      clearTimeout(window.__mlTimer);
      window.__mlTimer = null;
    }
  }
  clearMarkTimer();
  var root = document.querySelector('[data-ml]');
  if (!root) { return; }

  if (!document.getElementById('ml-overscroll')) {
    var overscroll = document.createElement('style');
    overscroll.setAttribute('id', 'ml-overscroll');
    overscroll.textContent = 'html:has(.ml) { overscroll-behavior-y: contain; }';
    (document.head || document.documentElement).appendChild(overscroll);
  }

  function csrf() {
    var m = document.cookie.match(/(?:^|;\\s*)crow_csrf=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  function request(method, url, body) {
    var options = { method: method, credentials: 'same-origin', headers: { 'x-crow-csrf': csrf() } };
    if (body !== undefined) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch(url, options).then(function (response) {
      return response.json().then(function (json) {
        return { ok: response.ok, status: response.status, json: json };
      }, function () {
        return { ok: response.ok, status: response.status, json: null };
      });
    }, function () {
      return { ok: false, status: 0, json: null };
    });
  }
  function post(url, body) { return request('POST', url, body); }
  function patch(url, body) { return request('PATCH', url, body); }
  function put(url, body) { return request('PUT', url, body); }
  function remove(url, body) { return request('DELETE', url, body); }

  function closestOf(node, selector) {
    if (node && typeof node.closest === 'function') { return node.closest(selector); }
    var found = node;
    while (found && found.getAttribute) {
      if (typeof found.matches === 'function' && found.matches(selector)) { return found; }
      found = found.parentNode;
    }
    return null;
  }
  function errorText(result) {
    var box = document.querySelector('[data-ml-errs]');
    var code = result && result.json && typeof result.json.error === 'string' && result.json.error !== ''
      ? result.json.error
      : 'network';
    if (!box) { return ''; }
    var text = box.getAttribute('data-ml-err-' + code.toLowerCase());
    // A code with no sentence of its own (owner_only, busy, unavailable, internal, unknown) shows the
    // generic one rather than nothing.
    if (!text) { text = box.getAttribute('data-ml-err-generic'); }
    return String(text || '');
  }
  function statusLine(host) {
    if (!host || typeof host.querySelector !== 'function') { return null; }
    var line = host.querySelector('[data-ml-status-line]');
    if (line) { return line; }
    line = document.createElement('p');
    line.className = 'ml-note ml-status-line';
    line.setAttribute('role', 'status');
    line.setAttribute('aria-live', 'polite');
    line.setAttribute('data-ml-status-line', '');
    line.setAttribute('hidden', '');
    host.appendChild(line);
    return line;
  }
  function say(host, text) {
    var line = statusLine(host);
    if (!line) { return; }
    var value = text === null || text === undefined ? '' : String(text);
    line.textContent = value;
    if (value === '') { line.setAttribute('hidden', ''); }
    else { line.removeAttribute('hidden'); }
  }
  function sayError(host, result) { say(host, errorText(result)); }

  function navigate(url) {
    var target = String(url || '');
    if (window.Turbo && typeof window.Turbo.visit === 'function') { window.Turbo.visit(target); return; }
    if (location && typeof location.assign === 'function') { location.assign(target); return; }
    if (location && typeof location.reload === 'function') { location.reload(); }
  }
  function reload() { navigate(String(location.href || '')); }

  function flashHref(value, base) {
    var href = String(base || location.href || '');
    var hash = '';
    var hashAt = href.indexOf('#');
    if (hashAt >= 0) { hash = href.slice(hashAt); href = href.slice(0, hashAt); }
    var queryAt = href.indexOf('?');
    var base = queryAt >= 0 ? href.slice(0, queryAt) : href;
    var pairs = queryAt >= 0 ? href.slice(queryAt + 1).split('&') : [];
    var kept = [];
    for (var i = 0; i < pairs.length; i++) {
      if (pairs[i] !== '' && pairs[i].indexOf('flash=') !== 0) { kept.push(pairs[i]); }
    }
    kept.push('flash=' + encodeURIComponent(String(value)));
    return base + '?' + kept.join('&') + hash;
  }

  function accountIds(value) {
    var out = [];
    var parts = String(value || '').split(',');
    for (var i = 0; i < parts.length; i++) {
      var id = parts[i].trim();
      if (id !== '' && out.indexOf(id) < 0) { out.push(id); }
    }
    return out;
  }

  var refreshing = false;
  function refreshAll(trigger) {
    if (refreshing) { return; }
    var button = trigger || root.querySelector('[data-ml-refresh]');
    var ids = accountIds(button ? button.getAttribute('data-accounts') : '');
    if (!ids.length) { return; }
    refreshing = true;
    var control = root.querySelector('[data-ml-refresh]');
    if (control) { control.setAttribute('disabled', ''); }
    var host = button && button.parentNode ? button.parentNode : root;
    say(host, button ? String(button.getAttribute('data-ml-refreshing') || '') : '');
    var calls = [];
    for (var i = 0; i < ids.length; i++) {
      calls.push(post('/dashboard/mail/api/accounts/' + encodeURIComponent(ids[i]) + '/sync', {}));
    }
    Promise.all(calls).then(function (results) {
      for (var j = 0; j < results.length; j++) {
        if (!results[j].ok) {
          // A failed round frees the control, so the owner can ask again.
          refreshing = false;
          if (control) { control.removeAttribute('disabled'); }
          sayError(host, results[j]);
          return;
        }
      }
      reload();
    });
  }

  function goOlder(button) {
    var ids = accountIds(button.getAttribute('data-folders'));
    if (!ids.length) { return; }
    var host = button.parentNode || root;
    var calls = [];
    for (var i = 0; i < ids.length; i++) {
      calls.push(post('/dashboard/mail/api/folders/' + encodeURIComponent(ids[i]) + '/older', {}));
    }
    Promise.all(calls).then(function (results) {
      var added = 0;
      for (var j = 0; j < results.length; j++) {
        if (!results[j].ok) { sayError(host, results[j]); return; }
        var json = results[j].json || {};
        added += Number(json.added) || 0;
      }
      navigate(flashHref(added > 0 ? 'older:' + String(added) : 'start'));
    });
  }

  function searchRemote(button) {
    var text = String(button.getAttribute('data-q') || '');
    var scope = String(button.getAttribute('data-acct') || 'all');
    if (text === '') { return; }
    var host = button.parentNode || root;
    post('/dashboard/mail/api/search/remote', { q: text, account: scope }).then(function (result) {
      if (!result.ok) { sayError(host, result); return; }
      var added = Number(result.json && result.json.added) || 0;
      navigate(flashHref('remote:' + String(added)));
    });
  }

  /* ---- message actions: read, unread, archive, delete and move ----------------------------- */

  var ACTION_PATH = '/dashboard/mail/api/messages/';
  var MARK_READ_DELAY_MS = 1500;
  // The note each returning action leaves on the list it goes back to; a move adds the folder's id.
  var ACTION_FLASH = { archive: 'archived', delete: 'deleted' };
  var actionBusy = false;

  function actionUrl(row) {
    return ACTION_PATH + encodeURIComponent(String(row)) + '/actions';
  }
  function actionControls() {
    var out = [];
    var bars = root.querySelectorAll('[data-ml-actions]');
    for (var i = 0; i < bars.length; i++) {
      var found = bars[i].querySelectorAll('[data-ml-action]');
      for (var j = 0; j < found.length; j++) { out.push(found[j]); }
    }
    return out;
  }
  // One action at a time: every control in the bar waits for the answer, so a double tap is one
  // intention and never two POSTs.
  function setActionsWaiting(waiting) {
    var controls = actionControls();
    for (var i = 0; i < controls.length; i++) {
      if (waiting) { controls[i].setAttribute('disabled', ''); }
      else { controls[i].removeAttribute('disabled'); }
    }
  }
  // The two read controls are always drawn and one of them is hidden. An answer that changed the
  // message's read state swaps them: 'read' hides Mark read and shows Mark unread, 'unread' the other
  // way round. Anything else about the bar is left alone.
  function swapReadControls(bar, action) {
    if (!bar || typeof bar.querySelectorAll !== 'function') { return; }
    var found = bar.querySelectorAll('[data-ml-action]');
    var read = null;
    var unread = null;
    for (var i = 0; i < found.length; i++) {
      var verb = String(found[i].getAttribute('data-ml-action') || '');
      if (verb === 'read') { read = found[i]; }
      if (verb === 'unread') { unread = found[i]; }
    }
    if (!read || !unread) { return; }
    var reading = action === 'read';
    if (reading) {
      read.setAttribute('hidden', '');
      unread.removeAttribute('hidden');
    } else {
      unread.setAttribute('hidden', '');
      read.removeAttribute('hidden');
    }
  }
  // The list the person came from: the page's own back link, never a URL built here.
  function backHref() {
    var back = root.querySelector('a.ml-back');
    var href = back ? String(back.getAttribute('href') || '') : '';
    return href === '' ? String(location.href || '') : href;
  }
  function runAction(control, action, folderId) {
    if (actionBusy) { return; }
    var row = String(control.getAttribute('data-row') || '');
    if (row === '') { return; }
    var bar = closestOf(control, '[data-ml-actions]') || root;
    var body = { action: action };
    if (folderId) { body.folderId = folderId; }
    actionBusy = true;
    setActionsWaiting(true);
    post(actionUrl(row), body).then(function (result) {
      if (!result.ok) {
        // Only a failure frees the bar: the action changed nothing, so another try is allowed.
        actionBusy = false;
        setActionsWaiting(false);
        sayError(bar, result);
        return;
      }
      // Mark unread and Mark read leave the reader on the message: the bar is usable again and the two
      // read controls swap. Mark unread also says its own sentence, which the bar carries; Mark read
      // says nothing, because the plan approved no sentence for it.
      if (action === 'unread' || action === 'read') {
        actionBusy = false;
        setActionsWaiting(false);
        swapReadControls(bar, action);
        if (action === 'unread') { say(bar, bar ? String(bar.getAttribute('data-ml-done-unread') || '') : ''); }
        return;
      }
      // Archive, delete and move change which list the person was looking at, so the reader goes back
      // to that list carrying the action's own note. It is already on its way out: the bar stays
      // disabled, and a click that lands while the next page loads sends nothing.
      var note = action === 'move' ? 'moved:' + String(folderId) : ACTION_FLASH[action];
      navigate(flashHref(note, backHref()));
    });
  }
  function clickAction(control) {
    if (String(control.tagName || '').toLowerCase() !== 'button') { return; }
    var action = String(control.getAttribute('data-ml-action') || '');
    if (action === 'move') {
      var bar = closestOf(control, '[data-ml-actions]');
      var select = bar && typeof bar.querySelector === 'function' ? bar.querySelector('[data-ml-move-select]') : null;
      var chosen = select ? Number(select.value) : 0;
      if (!(chosen > 0)) { return; }
      runAction(control, 'move', chosen);
      return;
    }
    // A click on either read control is the person's own decision, so the automatic mark-read that is
    // still pending is cleared before it can fire over it.
    if (action === 'read' || action === 'unread') {
      clearMarkTimer();
      runAction(control, action);
      return;
    }
    if (action === 'archive' || action === 'delete') { runAction(control, action); }
  }
  // Opening an unread message marks it read once, 1.5 s after the page is shown, and only while the
  // page is visible: the GET itself writes nothing, so a prefetch marks nothing read. The timer lives
  // in window.__mlTimer, which this run already cleared and every departure clears again; a click on
  // either read control clears it too, so it can never override the person's own choice.
  function bindMarkRead() {
    var bar = root.querySelector('[data-ml-actions][data-ml-unread-row]');
    if (!bar) { return; }
    var row = String(bar.getAttribute('data-ml-unread-row') || '');
    if (row === '') { return; }
    window.__mlTimer = setTimeout(function () {
      window.__mlTimer = null;
      if (String(document.visibilityState || '') !== 'visible') { return; }
      post(actionUrl(row), { action: 'read' }).then(function (result) {
        if (!result.ok) { sayError(bar, result); return; }
        swapReadControls(bar, 'read');
      });
    }, MARK_READ_DELAY_MS);
  }

  var SLOT_SELECTOR = '[data-ml-frame' + '-slot]';
  // The one sandbox value a slot may carry: the server's own, substituted into this template.
  var SLOT_SANDBOX = __ML_SLOT_SANDBOX__;

  function makeNonce() {
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    var text = '';
    for (var i = 0; i < bytes.length; i++) { text += String.fromCharCode(bytes[i]); }
    return window.btoa(text).split('+').join('-').split('/').join('_').split('=').join('');
  }
  function buildFrame(slot, extraQuery) {
    var sandbox = String(slot.getAttribute('data-sandbox') || '');
    var src = String(slot.getAttribute('data-src') || '');
    if (src === '' || sandbox !== SLOT_SANDBOX) { return null; }
    var frame = document.createElement('iframe');
    frame.setAttribute('sandbox', sandbox);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    var nonce = makeNonce();
    frame.setAttribute('data-ml-nonce', nonce);
    frame.setAttribute('src', src + (extraQuery || '') + '#n=' + nonce);
    return frame;
  }
  function paintFrame(slot, extraQuery) {
    if (!slot) { return null; }
    var frame = buildFrame(slot, extraQuery);
    if (!frame) { return null; }
    while (slot.firstChild) { slot.removeChild(slot.firstChild); }
    slot.appendChild(frame);
    slot.setAttribute('data-ml-loaded', '1');
    return frame;
  }
  function sectionOf(node) { return closestOf(node, '[data-ml-msg]'); }
  function slotIn(node) {
    var section = sectionOf(node);
    if (section && typeof section.querySelector === 'function') {
      var inside = section.querySelector(SLOT_SELECTOR);
      if (inside) { return inside; }
    }
    return closestOf(node, SLOT_SELECTOR);
  }
  function bannerIn(node) {
    var section = sectionOf(node);
    if (section && typeof section.querySelector === 'function') { return section.querySelector('[data-ml-img-banner]'); }
    return closestOf(node, '[data-ml-img-banner]');
  }
  function bindSection(section) {
    if (section.getAttribute('data-ml-bound') === 'section') { return; }
    section.setAttribute('data-ml-bound', 'section');
    var slots = section.querySelectorAll(SLOT_SELECTOR);
    if (section.hasAttribute('open')) {
      for (var i = 0; i < slots.length; i++) { paintFrame(slots[i], ''); }
    }
    section.addEventListener('toggle', function () {
      if (!section.hasAttribute('open')) { return; }
      var found = section.querySelectorAll(SLOT_SELECTOR);
      for (var j = 0; j < found.length; j++) {
        if (found[j].getAttribute('data-ml-loaded') === '1') { continue; }
        paintFrame(found[j], '');
      }
    });
  }

  function frameFor(source) {
    var frames = document.querySelectorAll('[data-ml] iframe');
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow && frames[i].contentWindow === source) { return frames[i]; }
    }
    return null;
  }
  function clampHeight(value) {
    var height = Math.floor(Number(value));
    if (height < 120) { return 120; }
    if (height > 20000) { return 20000; }
    return height;
  }
  // The banner's own sentence for a count of hidden images: the integer the frame reported goes into
  // the sentence template the server drew for this count (its singular for exactly one, its plural
  // otherwise). Nothing else is ever put in it, and a count of 0 takes the line away.
  function blockedNote(banner, count) {
    var note = banner.querySelector('[data-ml-blocked-note]');
    if (!(count > 0)) {
      if (note && note.parentNode) { note.parentNode.removeChild(note); }
      return;
    }
    if (!note) {
      note = document.createElement('p');
      note.className = 'ml-note';
      note.setAttribute('role', 'status');
      note.setAttribute('data-ml-blocked-note', '');
      banner.insertBefore(note, banner.firstChild);
    }
    var template = String(banner.getAttribute(count === 1 ? 'data-ml-blocked-one' : 'data-ml-blocked-many') || '');
    note.textContent = template.split('{n}').join(String(count));
  }
  function onFrameReport(event) {
    // A sandboxed frame without allow-same-origin reports from the opaque origin, which is "null".
    if (!event || String(event.origin) !== 'null') { return; }
    if (!event.data) { return; }
    var data = event.data;
    if (typeof data !== 'object' || data.t !== 'crow-mail-frame') { return; }
    var frame = frameFor(event.source);
    if (!frame) { return; }
    var nonce = String(frame.getAttribute('data-ml-nonce') || '');
    if (nonce === '' || String(data.nonce || '') !== nonce) { return; }
    if (typeof data.height !== 'number' || !isFinite(data.height) || data.height < 0) { return; }
    var blocked = data.blocked;
    if (typeof blocked !== 'number' || !isFinite(blocked) || blocked < 0 || Math.floor(blocked) !== blocked) { return; }
    frame.style.height = clampHeight(data.height) + 'px';
    var banner = bannerIn(frame);
    if (!banner) { return; }
    var count = blocked > 0 ? Math.floor(blocked) : 0;
    blockedNote(banner, count);
    if (count > 0) {
      banner.setAttribute('data-ml-blocked', String(count));
      banner.removeAttribute('hidden');
    } else {
      banner.removeAttribute('data-ml-blocked');
      banner.setAttribute('hidden', '');
    }
  }

  function cardOf(node) { return closestOf(node, '[data-ml-account]') || root; }

  // Removing an account: the first click only reveals the block's own sentence and arms the button.
  // A later click sends the delete, but not before the arm has settled for 500 ms (a double tap is
  // one intention, not two), and the confirmation lapses after 8 s or when focus leaves the block.
  var CONFIRM_ARM_MS = 500;
  var CONFIRM_WINDOW_MS = 8000;
  var confirmBox = null;
  var confirmReady = false;
  var confirmArmTimer = null;
  var confirmWindowTimer = null;

  function disarmConfirm(box) {
    confirmReady = false;
    if (confirmArmTimer) { clearTimeout(confirmArmTimer); confirmArmTimer = null; }
    if (confirmWindowTimer) { clearTimeout(confirmWindowTimer); confirmWindowTimer = null; }
    if (!box) { return; }
    var button = box.querySelector('[data-ml-remove-account-btn]');
    if (button) { button.removeAttribute('data-ml-confirm'); }
    var sentence = box.querySelector('[data-ml-confirm-sentence]');
    if (sentence) { sentence.setAttribute('hidden', ''); }
  }
  function lapseConfirm() {
    confirmWindowTimer = null;
    var previous = confirmBox;
    confirmBox = null;
    disarmConfirm(previous);
  }
  function armConfirm(box, button) {
    if (confirmBox && confirmBox !== box) { disarmConfirm(confirmBox); }
    confirmBox = box;
    confirmReady = false;
    if (box) {
      var sentence = box.querySelector('[data-ml-confirm-sentence]');
      if (sentence) { sentence.removeAttribute('hidden'); }
    }
    button.setAttribute('data-ml-confirm', '1');
    if (confirmArmTimer) { clearTimeout(confirmArmTimer); }
    confirmArmTimer = setTimeout(function () {
      confirmArmTimer = null;
      confirmReady = true;
    }, CONFIRM_ARM_MS);
    if (confirmWindowTimer) { clearTimeout(confirmWindowTimer); }
    confirmWindowTimer = setTimeout(lapseConfirm, CONFIRM_WINDOW_MS);
  }

  function clickHandler(event) {
    var target = event.target && event.target.closest ? event.target : null;
    if (!target) { return; }

    var actionControl = target.closest('[data-ml-action]');
    if (actionControl) { clickAction(actionControl); return; }

    var show = target.closest('[data-ml-show-images]');
    if (show) { paintFrame(slotIn(show), '?images=1'); return; }

    var always = target.closest('[data-ml-always-images]');
    if (always) {
      var banner = bannerIn(always);
      var accountId = banner ? String(banner.getAttribute('data-account') || '') : '';
      var sender = banner ? String(banner.getAttribute('data-sender') || '') : '';
      if (accountId === '' || sender === '') { return; }
      always.disabled = true;
      post('/dashboard/mail/api/image-allow', { accountId: accountId, sender: sender }).then(function (result) {
        always.disabled = false;
        if (!result.ok) { sayError(banner, result); return; }
        paintFrame(slotIn(always), '?images=1');
      });
      return;
    }

    var refresh = target.closest('[data-ml-refresh]');
    if (refresh) { refreshAll(refresh); return; }

    var older = target.closest('[data-ml-older]');
    if (older) { goOlder(older); return; }

    var remote = target.closest('[data-ml-search-remote]');
    if (remote) { searchRemote(remote); return; }

    var sync = target.closest('[data-ml-sync]');
    if (sync) {
      var syncId = String(sync.getAttribute('data-account') || '');
      if (syncId === '') { return; }
      sync.disabled = true;
      post('/dashboard/mail/api/accounts/' + encodeURIComponent(syncId) + '/sync', {}).then(function (result) {
        sync.disabled = false;
        if (!result.ok) { sayError(cardOf(sync), result); return; }
        reload();
      });
      return;
    }

    var save = target.closest('[data-ml-password-save]');
    if (save) {
      var passwordId = String(save.getAttribute('data-account') || '');
      if (passwordId === '') { return; }
      var passwordBox = closestOf(save, '[data-ml-update-password]');
      var input = passwordBox ? passwordBox.querySelector('[data-ml-password-input]') : null;
      var secret = input ? String(input.value || '') : '';
      // The field is emptied as the secret leaves it, so it is not left sitting in the page.
      if (input) { input.value = ''; }
      save.disabled = true;
      put('/dashboard/mail/api/accounts/' + encodeURIComponent(passwordId) + '/password', { password: secret }).then(function (result) {
        save.disabled = false;
        if (!result.ok) { sayError(cardOf(save), result); return; }
        reload();
      });
      return;
    }

    var dropSender = target.closest('[data-ml-remove-sender]');
    if (dropSender) {
      var senderAccount = String(dropSender.getAttribute('data-account') || '');
      var allowSender = String(dropSender.getAttribute('data-sender') || '');
      if (senderAccount === '' || allowSender === '') { return; }
      dropSender.disabled = true;
      remove('/dashboard/mail/api/image-allow', { accountId: senderAccount, sender: allowSender }).then(function (result) {
        dropSender.disabled = false;
        if (!result.ok) { sayError(cardOf(dropSender), result); return; }
        var item = dropSender.parentNode;
        if (item && item.parentNode) { item.parentNode.removeChild(item); }
      });
      return;
    }

    var dropAccount = target.closest('[data-ml-remove-account-btn]');
    if (dropAccount) {
      var dropId = String(dropAccount.getAttribute('data-account') || '');
      if (dropId === '') { return; }
      var block = closestOf(dropAccount, '[data-ml-remove-account]');
      if (dropAccount.getAttribute('data-ml-confirm') !== '1') {
        armConfirm(block, dropAccount);
        return;
      }
      // Armed, but a click that follows the arming too closely is the same tap, not a confirmation.
      if (!confirmReady) { return; }
      confirmBox = null;
      disarmConfirm(block);
      dropAccount.setAttribute('disabled', '');
      remove('/dashboard/mail/api/accounts/' + encodeURIComponent(dropId), {}).then(function (result) {
        dropAccount.removeAttribute('disabled');
        if (!result.ok) { sayError(cardOf(dropAccount), result); return; }
        reload();
      });
      return;
    }
  }

  function changeHandler(event) {
    var target = event.target;
    if (!target || !target.getAttribute) { return; }
    var rename = target.closest ? target.closest('[data-ml-rename]') : null;
    if (rename) {
      var renameId = String(rename.getAttribute('data-account') || '');
      if (renameId === '') { return; }
      patch('/dashboard/mail/api/accounts/' + encodeURIComponent(renameId), { label: String(rename.value || '') })
        .then(function (result) { if (!result.ok) { sayError(cardOf(rename), result); } });
      return;
    }
    var local = target.closest ? target.closest('[data-ml-local-models]') : null;
    if (local) {
      var localId = String(local.getAttribute('data-account') || '');
      if (localId === '') { return; }
      patch('/dashboard/mail/api/accounts/' + encodeURIComponent(localId), { localModelsOnly: Boolean(local.checked) })
        .then(function (result) { if (!result.ok) { sayError(cardOf(local), result); } });
    }
  }

  /**
   * The add-account form's own submit: cancelled first, every time, and only then read. Its fields
   * include a secret and the form names no target, so a submit the browser performed could carry the
   * password into the page URL; there is no state — a missing cookie or a field the form does not
   * have — in which the form is handed back to the browser instead.
   */
  function bindAddForm(form) {
    if (form.getAttribute('data-ml-bound') === 'form') { return; }
    form.setAttribute('data-ml-bound', 'form');
    form.addEventListener('submit', function (event) {
      if (typeof event.preventDefault === 'function') { event.preventDefault(); }
      var field = function (name) {
        var input = form.querySelector('[name="' + name + '"]');
        return input ? String(input.value || '') : '';
      };
      var passwordInput = form.querySelector('[name="password"]');
      var body = {
        label: field('label'),
        address: field('address'),
        password: field('password'),
        imap: { host: field('imap-host'), port: Number(field('imap-port')), security: field('imap-security') },
        smtp: { host: field('smtp-host'), port: Number(field('smtp-port')), security: field('smtp-security') }
      };
      // Emptied as it is sent, so a secret is never left in the form whatever the answer is.
      if (passwordInput) { passwordInput.value = ''; }
      post('/dashboard/mail/api/accounts', body).then(function (result) {
        if (!result.ok) { sayError(form, result); return; }
        reload();
      });
    });
  }

  function bindPull(list) {
    if (list.getAttribute('data-ml-bound') === 'pull') { return; }
    list.setAttribute('data-ml-bound', 'pull');
    var start = null;
    list.addEventListener('touchstart', function (event) {
      var touch = event.touches && event.touches[0];
      start = touch && window.scrollY === 0 ? touch.clientY : null;
    });
    list.addEventListener('touchend', function (event) {
      if (start === null) { return; }
      var touch = event.changedTouches && event.changedTouches[0];
      var end = touch ? touch.clientY : start;
      var distance = end - start;
      start = null;
      if (window.scrollY !== 0 || distance < 80) { return; }
      refreshAll(root.querySelector('[data-ml-refresh]'));
    });
  }

  if (root.getAttribute('data-ml-bound') !== 'root') {
    root.setAttribute('data-ml-bound', 'root');
    root.addEventListener('click', clickHandler);
    root.addEventListener('change', changeHandler);
    root.addEventListener('focusout', function (event) {
      if (!confirmBox) { return; }
      var next = event && event.relatedTarget;
      if (next && confirmBox.contains && confirmBox.contains(next)) { return; }
      var previous = confirmBox;
      confirmBox = null;
      disarmConfirm(previous);
    });
  }
  var sections = root.querySelectorAll('[data-ml-msg]');
  for (var i = 0; i < sections.length; i++) { bindSection(sections[i]); }
  var lists = root.querySelectorAll('.ml-list');
  for (var j = 0; j < lists.length; j++) { bindPull(lists[j]); }
  var addForms = root.querySelectorAll('[data-ml-add-account]');
  for (var k = 0; k < addForms.length; k++) { bindAddForm(addForms[k]); }
  bindMarkRead();

  if (!window.__mlBound) {
    window.__mlBound = true;
    window.addEventListener('message', onFrameReport);
    document.addEventListener('turbo:before-visit', clearMarkTimer);
    window.addEventListener('pagehide', clearMarkTimer);
  }
})();
</script>`.split("__ML_SLOT_SANDBOX__").join(JSON.stringify(FRAME_IFRAME_SANDBOX));
}

export default mailClientJs;