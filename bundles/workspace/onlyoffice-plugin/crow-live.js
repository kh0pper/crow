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
 *
 * Comment reports (0.3.0, comment loop Phase 1): a sensor only; it writes nothing and shows nothing. At ready the
 * plugin reads GetAllComments as a baseline (Id → signature of who/when/what, Solved left out); comment events before
 * that only fill the baseline. A later event whose thread gained or changed a comment whose text has an @mention is
 * POSTed to /comments with occ (computed over every comment the way keys.flatten counts identical
 * author/second/quote tuples). Threads over the server's limits are not sent. A 401 is re-sent at +5 s and +15 s,
 * then dropped; 429 and network errors are dropped. Every request carries X-Crow-File-Hint: the fileId claim of the
 * documentCallbackUrl's doc token (spike E10), read but never verified here; the gateway treats it as a hint only.
 */
(function (window) {
  var VERSION = "0.3.0", BASE = "/crow-live/v1";
  var POLL_FOCUSED_MS = 5000, POLL_VISIBLE_MS = 15000, POLL_HIDDEN_MS = 60000, ERROR_BACKOFF_MS = 60000;
  var INDICATOR_MIN_MS = 2500, IDLE_STOP_MS = 8 * 3600e3, APPLY_WATCHDOG_MS = 30000;
  var INDICATOR_TEXT = "Crow is editing…";
  var timer = null, idleSince = Date.now(), busy = false, stopped = false, indicatorAt = 0, indicatorOffTimer = null, indicatorShown = false;
  var backoffUntil = 0, lastPollAt = 0;
  var TEXT_MAX = 4096, REPLIES_MAX = 50, REPORT_RETRY_MS = [5000, 15000], MENTION_RE = /(^|\s)@[A-Za-z0-9]/;
  var baseline = {}, ready = false;
  function info() { return window.Asc.plugin.info || {}; }
  /** The fileId claim of documentCallbackUrl's doc token (E10), as a decimal string, or null. Unverified: a hint. */
  function fileHint() {
    try {
      var m = /[?&]doc=([^&#]+)/.exec(String(info().documentCallbackUrl || ""));
      var part = m && decodeURIComponent(m[1]).split(".")[1];
      if (!part || typeof window.atob !== "function") return null;
      var b = part.replace(/-/g, "+").replace(/_/g, "/");
      while (b.length % 4) b += "=";
      var id = JSON.parse(window.atob(b)).fileId;
      return /^[1-9]\d{0,15}$/.test(String(id)) ? String(id) : null;
    } catch (e) { return null; }
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = { Authorization: "Bearer " + info().jwt, "Content-Type": "application/json" };
    var hint = fileHint();
    if (hint) opts.headers["X-Crow-File-Hint"] = hint;
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
    if (indicatorShown) return; // still up from the previous change: one StartAction, one EndAction
    indicatorShown = true;
    try { window.Asc.plugin.executeMethod("StartAction", ["Information", INDICATOR_TEXT]); } catch (e) { /* no indicator */ }
  }
  function indicatorOff() {
    var wait = Math.max(0, indicatorAt + INDICATOR_MIN_MS - Date.now());
    clearTimeout(indicatorOffTimer);
    indicatorOffTimer = setTimeout(function () {
      indicatorOffTimer = null; indicatorShown = false;
      try { window.Asc.plugin.executeMethod("EndAction", ["Information", INDICATOR_TEXT]); } catch (e) { /* no indicator */ }
    }, wait);
  }
  function schedule(ms) { if (stopped) return; clearTimeout(timer); timer = setTimeout(poll, ms); }
  function failed(e) {
    busy = false;
    if (e && e.status === 426) { stopped = true; return; } // outdated plugin: the document must be reloaded
    if (e && (e.status === 401 || e.status === 409)) return schedule(pollDelay()); // nothing for this document now (or not allowed), or a claim lost to the close-time applier: keep the cadence
    backoffUntil = Date.now() + ERROR_BACKOFF_MS; // 429, 5xx, network: a wake-up does not cut this short
    schedule(ERROR_BACKOFF_MS);
  }
  function poll() {
    var i = info();
    if (stopped || i.isViewMode || !i.jwt || !i.documentId || Date.now() - idleSince > IDLE_STOP_MS) return; // view mode / no token / 8 h idle: stop
    if (busy) return schedule(POLL_FOCUSED_MS);
    busy = true; lastPollAt = Date.now();
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
        var finish = function (res) {
          if (done) return;
          done = true; clearTimeout(watchdog); indicatorOff();
          res = res || { ok: false, reason: "no_result" };
          api("/ack", { method: "POST", body: JSON.stringify({ change_id: ch.change_id, apply_token: cl.apply_token, outcome: res.ok ? "applied" : "failed", applied_nothing: res.applied_nothing === true, reason: res.reason }) })
            .catch(function () { /* the lease expires → unknown_after_claim → postcondition at close */ })
            .then(function () { busy = false; schedule(1000); });
        };
        // a synchronous throw ran nothing of the op: report it (ambiguous → the postcondition decides at close)
        try { window.Asc.plugin.callCommand(window.crowCommand, false, true, finish); }
        catch (e) { finish({ ok: false, reason: "call_failed" }); }
      });
    }).catch(failed);
  }
  // Coming back to the tab/window polls soon — never during an error back-off, never sooner than one focused
  // interval after the last poll (window focus only: no capture, so clicks inside the editor do not trigger it).
  function wake() {
    if (busy || stopped) return;
    var now = Date.now(), at = Math.max(now + 500, backoffUntil, lastPollAt + POLL_FOCUSED_MS);
    schedule(at - now);
  }
  // ---- comment reports ----
  function str(v) { return v === undefined || v === null ? "" : String(v); }
  function nfc(s) { s = str(s); try { return s.normalize("NFC"); } catch (e) { return s; } }
  function normQuote(s) { return nfc(s).replace(/\s+/g, " ").trim(); }
  function second(t) { var n = Number(t); return isFinite(n) ? String(Math.floor(n / 1000)) : str(t); }
  /** One comment's identity + text: what a report is about (Solved and the quote are left out). */
  function line(c) { return JSON.stringify([str(c.UserName), str(c.Time), str(c.Text)]); }
  function linesOf(d) { var out = [line(d)], r = d.Replies || []; for (var i = 0; i < r.length; i++) out.push(line(r[i])); return out; }
  function sigOf(d) { return JSON.stringify(linesOf(d)); }
  function remember(list) { for (var i = 0; i < (list || []).length; i++) if (list[i] && list[i].Data) baseline[list[i].Id] = sigOf(list[i].Data); }
  /** occ for each comment of thread `id` (root, then replies), counted over all comments as keys.flatten does. */
  function occOf(all, id) {
    var seen = {}, mine = null;
    for (var i = 0; i < all.length; i++) {
      var d = all[i].Data || {}, q = normQuote(d.QuoteText), list = [d].concat(d.Replies || []), occ = [];
      for (var j = 0; j < list.length; j++) {
        var k = JSON.stringify([nfc(list[j].UserName), second(list[j].Time), q]);
        var n = seen[k] || 0; seen[k] = n + 1; occ.push(n);
      }
      if (all[i].Id === id) mine = occ;
    }
    return mine;
  }
  function overLimit(d) {
    var list = [d].concat(d.Replies || []);
    if ((d.Replies || []).length > REPLIES_MAX || str(d.QuoteText).length > TEXT_MAX) return true;
    for (var i = 0; i < list.length; i++) if (str(list[i].Text).length > TEXT_MAX || str(list[i].UserName).length > 200) return true;
    return false;
  }
  function send(body, attempt) {
    api("/comments", { method: "POST", body: JSON.stringify(body) }).catch(function (e) {
      if (e && e.status === 401 && attempt < REPORT_RETRY_MS.length) {
        var wait = REPORT_RETRY_MS[attempt] - (attempt ? REPORT_RETRY_MS[attempt - 1] : 0);
        setTimeout(function () { send(body, attempt + 1); }, wait);
      } // anything else (429, network, 4xx, 5xx): dropped
    });
  }
  function report(kind, ev) {
    if (!ev || !ev.Id || !ev.Data) return;
    var before = baseline[ev.Id], sig = sigOf(ev.Data);
    baseline[ev.Id] = sig;
    if (!ready || before === sig) return; // before ready: baseline only
    var old = {}, prev = before ? JSON.parse(before) : [], lines = linesOf(ev.Data), list = [ev.Data].concat(ev.Data.Replies || []), hit = false;
    for (var i = 0; i < prev.length; i++) old[prev[i]] = true;
    for (var j = 0; j < lines.length; j++) if (!old[lines[j]] && MENTION_RE.test(str(list[j].Text))) hit = true;
    if (!hit || overLimit(ev.Data)) return;
    var i0 = info();
    if (i0.isViewMode || !i0.jwt || !i0.documentId) return;
    window.Asc.plugin.executeMethod("GetAllComments", [], function (all) {
      var occ = occOf(all || [], ev.Id);
      if (!occ || occ.length !== list.length) return; // the thread is gone (or changed again): the next event reports it
      var d = ev.Data, reps = [];
      for (var k = 0; k < (d.Replies || []).length; k++) reps.push({ Text: str(d.Replies[k].Text), Time: d.Replies[k].Time, UserName: str(d.Replies[k].UserName) });
      send({ key: i0.documentId, pv: VERSION, kind: kind, occ: occ,
        thread: { Id: String(ev.Id), Text: str(d.Text), Time: d.Time, UserName: str(d.UserName), QuoteText: str(d.QuoteText), Solved: d.Solved === true, Replies: reps } }, 0);
    });
  }
  function takeBaseline() {
    try {
      window.Asc.plugin.executeMethod("GetAllComments", [], function (all) { remember(all); ready = true; });
    } catch (e) { /* no comment API: never reports */ }
  }

  try { window.document.addEventListener("visibilitychange", function () { if (visible()) wake(); }); } catch (e) { /* ignore */ }
  try { if (window.parent && window.parent !== window) window.parent.addEventListener("focus", wake); } catch (e) { /* cross-origin */ }
  window.crowLive = { pollDelay: pollDelay, wake: wake, version: VERSION, report: report };
  window.Asc.plugin.init = function () { schedule(3000); };
  window.Asc.plugin.event_onDocumentContentReady = function () { schedule(1000); if (!ready) takeBaseline(); };
  window.Asc.plugin.event_onAddComment = function (ev) { report("add", ev); };
  window.Asc.plugin.event_onChangeCommentData = function (ev) { report("change", ev); };
  window.Asc.plugin.button = function () {};
})(window);
