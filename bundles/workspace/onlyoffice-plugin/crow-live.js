/*
 * Crow live edits (K5, spec §5.7): poll Crow for changes queued for THIS document, claim one, apply it with
 * callCommand (one group action, so Ctrl-Z in the editor reverts it), ack the result.
 * Same origin: the editor's Serve port proxies /crow-live → the Crow gateway's /api/workspace/live (tailnet only).
 * Auth is the editor's own session token (Asc.plugin.info.jwt); nothing long-lived lives here.
 * View mode (phones, read-only shares) never polls or claims: those changes apply when the file is closed.
 */
(function (window) {
  var VERSION = "0.2.0", BASE = "/crow-live/v1", timer = null, idleSince = Date.now(), busy = false;
  function info() { return window.Asc.plugin.info || {}; }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = { Authorization: "Bearer " + info().jwt, "Content-Type": "application/json" };
    opts.credentials = "omit";
    return fetch(BASE + path, opts).then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); });
  }
  function indicator(on) { try { window.Asc.plugin.executeMethod(on ? "StartAction" : "EndAction", ["Information", "Crow is editing…"]); } catch (e) { /* no indicator */ } }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(poll, ms); }
  function poll() {
    var i = info();
    if (i.isViewMode || !i.jwt || !i.documentId || Date.now() - idleSince > 8 * 3600e3) return; // view mode / no token / 8 h idle: stop
    if (busy) return schedule(10000);
    api("/pending?key=" + encodeURIComponent(i.documentId) + "&pv=" + VERSION).then(function (list) {
      if (!list || !list.length) return schedule(Math.min(60000, 10000 + (Date.now() - idleSince) / 60));
      idleSince = Date.now(); busy = true;
      var ch = list[0];
      return api("/claim", { method: "POST", body: JSON.stringify({ change_id: ch.change_id, pv: VERSION }) }).then(function (cl) {
        indicator(true);
        window.Asc.scope.crow = { tool: ch.tool, args: ch.args, pre: ch.pre };
        var done = false;
        // the callback may never fire (e.g. a modal dialog): give up locally; the server lease expires → unknown_after_claim
        var watchdog = setTimeout(function () { if (!done) { done = true; indicator(false); busy = false; schedule(60000); } }, 30000);
        window.Asc.plugin.callCommand(window.crowCommand, false, true, function (res) {
          if (done) return;
          done = true; clearTimeout(watchdog); indicator(false);
          res = res || { ok: false, reason: "no_result" };
          api("/ack", { method: "POST", body: JSON.stringify({ change_id: ch.change_id, apply_token: cl.apply_token, outcome: res.ok ? "applied" : "failed", applied_nothing: res.applied_nothing === true, reason: res.reason, inverse: res.inverse || null }) })
            .catch(function () { /* the lease expires → unknown_after_claim → postcondition at close */ })
            .then(function () { busy = false; schedule(1000); });
        });
      });
    }).catch(function () { busy = false; schedule(60000); });
  }
  window.Asc.plugin.init = function () { schedule(3000); };
  window.Asc.plugin.event_onDocumentContentReady = function () { schedule(1000); };
  window.Asc.plugin.button = function () {};
})(window);
