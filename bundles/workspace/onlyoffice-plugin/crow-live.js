/*
 * Crow live edits (K5, spec §5.7): poll Crow for changes queued for THIS document, claim one, apply it with
 * callCommand (one group action, so Ctrl-Z in the editor reverts it), ack the result.
 * Same origin: the editor's Serve port proxies /crow-live → the Crow gateway's /api/workspace/live (tailnet only).
 * Auth is the editor's own session token (Asc.plugin.info.jwt); nothing long-lived lives here.
 * View mode (phones, read-only shares) never polls or claims: those changes apply when the file is closed.
 *
 * Poll cadence (live acceptance: a 10–60 s back-off made a queued change wait ~45 s): every POLL_FOCUSED_MS while
 * the editor has focus, POLL_VISIBLE_MS while its tab is visible but not focused, POLL_HIDDEN_MS while hidden; a
 * return to the tab/focus polls at once. "Nothing for this document" is the server's 401 (it answers every
 * auth/no-work case alike, so a viewer learns nothing) and keeps the normal cadence; 429 / network errors back
 * off ERROR_BACKOFF_MS; 426 (outdated plugin) stops. 5 s is 12 polls/min, under the server's 60/min per editor.
 * The "Crow is editing…" indicator stays up at least INDICATOR_MIN_MS: a callCommand finishes in milliseconds,
 * and an EndAction sent right behind StartAction is never seen.
 */
(function (window) {
  var VERSION = "0.2.1", BASE = "/crow-live/v1";
  var POLL_FOCUSED_MS = 5000, POLL_VISIBLE_MS = 15000, POLL_HIDDEN_MS = 60000, ERROR_BACKOFF_MS = 60000;
  var INDICATOR_MIN_MS = 2500, IDLE_STOP_MS = 8 * 3600e3, APPLY_WATCHDOG_MS = 30000;
  var INDICATOR_TEXT = "Crow is editing…";
  var timer = null, idleSince = Date.now(), busy = false, stopped = false, indicatorAt = 0, indicatorOffTimer = null;
  function info() { return window.Asc.plugin.info || {}; }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = { Authorization: "Bearer " + info().jwt, "Content-Type": "application/json" };
    opts.credentials = "omit";
    return fetch(BASE + path, opts).then(function (r) {
      if (!r.ok) { var e = new Error("http " + r.status); e.status = r.status; throw e; }
      return r.json();
    });
  }
  // The plugin frame is hidden; focus belongs to the editor frame (same origin) — read it there when allowed.
  function focused() {
    var docs = [];
    try { if (window.parent && window.parent !== window) docs.push(window.parent.document); } catch (e) { /* cross-origin */ }
    try { if (window.top && window.top !== window && window.top !== window.parent) docs.push(window.top.document); } catch (e) { /* cross-origin */ }
    for (var i = 0; i < docs.length; i++) { try { if (docs[i] && docs[i].hasFocus && docs[i].hasFocus()) return true; } catch (e) { /* ignore */ } }
    return docs.length === 0 ? visible() : false; // no readable parent: a visible tab counts as focused
  }
  function visible() { try { return !window.document || window.document.visibilityState !== "hidden"; } catch (e) { return true; } }
  /** The next poll delay for the editor's current state (exported for tests as crowLive.pollDelay). */
  function pollDelay() { return !visible() ? POLL_HIDDEN_MS : focused() ? POLL_FOCUSED_MS : POLL_VISIBLE_MS; }
  function indicatorOn() {
    clearTimeout(indicatorOffTimer); indicatorOffTimer = null;
    indicatorAt = Date.now();
    try { window.Asc.plugin.executeMethod("StartAction", ["Information", INDICATOR_TEXT]); } catch (e) { /* no indicator */ }
  }
  function indicatorOff() {
    var wait = Math.max(0, indicatorAt + INDICATOR_MIN_MS - Date.now());
    clearTimeout(indicatorOffTimer);
    indicatorOffTimer = setTimeout(function () {
      indicatorOffTimer = null;
      try { window.Asc.plugin.executeMethod("EndAction", ["Information", INDICATOR_TEXT]); } catch (e) { /* no indicator */ }
    }, wait);
  }
  function schedule(ms) { if (stopped) return; clearTimeout(timer); timer = setTimeout(poll, ms); }
  function failed(e) {
    busy = false;
    if (e && e.status === 426) { stopped = true; return; } // outdated plugin: the document must be reloaded
    if (e && (e.status === 401 || e.status === 409)) return schedule(pollDelay()); // nothing for this document now (or not allowed), or a claim lost to the close-time applier: keep the cadence
    schedule(ERROR_BACKOFF_MS); // 429, 5xx, network
  }
  function poll() {
    var i = info();
    if (stopped || i.isViewMode || !i.jwt || !i.documentId || Date.now() - idleSince > IDLE_STOP_MS) return; // view mode / no token / 8 h idle: stop
    if (busy) return schedule(POLL_FOCUSED_MS);
    busy = true;
    api("/pending?key=" + encodeURIComponent(i.documentId) + "&pv=" + VERSION).then(function (list) {
      if (!list || !list.length) { busy = false; return schedule(pollDelay()); }
      idleSince = Date.now();
      var ch = list[0];
      return api("/claim", { method: "POST", body: JSON.stringify({ change_id: ch.change_id, pv: VERSION }) }).then(function (cl) {
        indicatorOn();
        window.Asc.scope.crow = { tool: ch.tool, args: ch.args, pre: ch.pre };
        var done = false;
        // the callback may never fire (e.g. a modal dialog): give up locally; the server lease expires → unknown_after_claim
        var watchdog = setTimeout(function () { if (!done) { done = true; indicatorOff(); busy = false; schedule(ERROR_BACKOFF_MS); } }, APPLY_WATCHDOG_MS);
        window.Asc.plugin.callCommand(window.crowCommand, false, true, function (res) {
          if (done) return;
          done = true; clearTimeout(watchdog); indicatorOff();
          res = res || { ok: false, reason: "no_result" };
          api("/ack", { method: "POST", body: JSON.stringify({ change_id: ch.change_id, apply_token: cl.apply_token, outcome: res.ok ? "applied" : "failed", applied_nothing: res.applied_nothing === true, reason: res.reason }) })
            .catch(function () { /* the lease expires → unknown_after_claim → postcondition at close */ })
            .then(function () { busy = false; schedule(1000); });
        });
      });
    }).catch(failed);
  }
  function wake() { if (!busy && !stopped) schedule(500); }
  try { window.document.addEventListener("visibilitychange", function () { if (visible()) wake(); }); } catch (e) { /* ignore */ }
  try { if (window.parent && window.parent !== window) window.parent.addEventListener("focus", wake, true); } catch (e) { /* cross-origin */ }
  window.crowLive = { pollDelay: pollDelay, version: VERSION };
  window.Asc.plugin.init = function () { schedule(3000); };
  window.Asc.plugin.event_onDocumentContentReady = function () { schedule(1000); };
  window.Asc.plugin.button = function () {};
})(window);
