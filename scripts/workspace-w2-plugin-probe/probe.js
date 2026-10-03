// W2 spike S9: ONLYOFFICE live-plugin probe (temporary; copied into the running container by run-probe.sh
// and removed again at the end). Reports to the loopback listener through the tailnet Serve path
// /crow-live/probe (same origin as the editor). The token is sent ONLY there; the listener keeps claims, not the token.
//
// Every callCommand body below is self-contained (no closures over plugin scope): ONLYOFFICE 9.4 runs it through
// AscCommon.safePluginEval. Data goes in through Asc.scope.
(function (window) {
  var BASE = "/crow-live/probe";
  var started = false;
  var sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);

  function post(kind, data) {
    data = data || {};
    data.kind = kind; data.session = sessionId; data.t = Date.now();
    try {
      return fetch(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
        .catch(function () {});
    } catch (e) { return null; }
  }

  // callCommand with a timeout: if the callback never fires (e.g. the user is editing a cell), report that.
  function run(name, fn, isCalc, done) {
    var finished = false;
    var timer = setTimeout(function () { if (!finished) { finished = true; done({ callback: false, timeout_ms: 10000 }); } }, 10000);
    try {
      window.Asc.plugin.callCommand(fn, false, isCalc, function (res) {
        if (finished) return; finished = true; clearTimeout(timer);
        done({ callback: true, result: res === undefined ? null : res });
      });
    } catch (e) {
      if (!finished) { finished = true; clearTimeout(timer); done({ callback: false, threw: String(e && e.message || e) }); }
    }
  }

  // S9_callcommand_structured_result: a local object literal + an inner function call.
  function structuredCommand() {
    var o = { a: 1, f: function (x) { return x + 1; } };
    function inner(v) { return { ok: v === 2, n: v, kind: typeof o }; }
    return inner(o.f(o.a));
  }

  // typeof report for every builder method ops.js intends to use. Returns { "<Class>.<Method>": true|false, ... }.
  function presenceCommand() {
    var t = Asc.scope.probeEditor, out = {}, errors = [];
    function has(label, obj, names) {
      for (var i = 0; i < names.length; i++) {
        var ok = false;
        try { ok = !!obj && typeof obj[names[i]] === "function"; } catch (e) { errors.push(label + "." + names[i] + ": " + e); }
        out[label + "." + names[i]] = ok;
      }
    }
    function safe(f) { try { return f(); } catch (e) { errors.push(String(e)); return null; } }
    if (t === "word") {
      has("Api", Api, ["GetDocument", "CreateParagraph", "CreateRun"]);
      var doc = safe(function () { return Api.GetDocument(); });
      has("ApiDocument", doc, ["SearchAndReplace", "Search", "Push", "GetAllParagraphs", "GetAllHeadingParagraphs", "GetStyle"]);
      var p = safe(function () { return Api.CreateParagraph(); });
      has("ApiParagraph", p, ["AddText", "SetStyle", "InsertParagraph", "GetText", "RemoveAllElements", "GetRange"]);
      var r = safe(function () { if (p) p.AddText("probe"); return p && typeof p.GetRange === "function" ? p.GetRange() : null; });
      has("ApiRange", r, ["SetBold", "SetItalic", "SetUnderline", "SetColor", "AddComment"]);
      var run = safe(function () { return Api.CreateRun(); });
      has("ApiRun", run, ["GetTextPr", "SetTextPr"]);
    } else if (t === "cell") {
      has("Api", Api, ["GetSheet", "GetActiveSheet", "AddSheet"]);
      var ws = safe(function () { return Api.GetActiveSheet(); });
      has("ApiWorksheet", ws, ["GetRange", "GetUsedRange", "SetName"]);
      var rg = safe(function () { return ws ? ws.GetRange("A1") : null; });
      has("ApiRange", rg, ["SetValue", "GetValue", "SetNumberFormat"]);
    } else if (t === "slide") {
      has("Api", Api, ["GetPresentation"]);
      var pres = safe(function () { return Api.GetPresentation(); });
      has("ApiPresentation", pres, ["GetSlideByIndex"]);
      var sl = safe(function () { return pres ? pres.GetSlideByIndex(0) : null; });
      has("ApiSlide", sl, ["GetAllShapes"]);
      var shapes = safe(function () { return sl ? sl.GetAllShapes() : null; });
      has("ApiShape", shapes && shapes.length ? shapes[0] : null, ["GetDocContent"]);
    }
    return { editor: t, present: out, errors: errors };
  }

  // Edit (not view mode): word appends a paragraph, cell writes Z99 and reads it back.
  function wordEditCommand() {
    var doc = Api.GetDocument();
    var p = Api.CreateParagraph();
    p.AddText("CROW-PROBE");
    doc.Push(p);
    return { ok: true };
  }
  function cellTickCommand() {
    var n = Asc.scope.probeTick;
    var ws = Api.GetActiveSheet();
    var rg = ws.GetRange("Z99");
    rg.SetValue("CROW-PROBE " + n);
    var back = ws.GetRange("Z99").GetValue();
    return { ok: back === "CROW-PROBE " + n, tick: n, readback: String(back) };
  }

  function indicator(done) {
    var res = { start: null, end: null };
    try { window.Asc.plugin.executeMethod("StartAction", ["Information", "Crow probe…"]); res.start = "called"; }
    catch (e) { res.start = "threw: " + (e && e.message || e); }
    setTimeout(function () {
      try { window.Asc.plugin.executeMethod("EndAction", ["Information", "Crow probe…"]); res.end = "called"; }
      catch (e) { res.end = "threw: " + (e && e.message || e); }
      done(res);
    }, 6000); // long enough for Kevin to see it
  }

  function start() {
    if (started) return; started = true;
    var info = window.Asc.plugin.info || {};
    var editor = info.editorType;
    post("init", {
      documentId: info.documentId, userId: info.userId, userName: info.userName,
      editorType: editor, isViewMode: info.isViewMode, isMobileMode: info.isMobileMode,
      infoKeys: Object.keys(info), jwt: info.jwt
    });
    window.Asc.scope.probeEditor = editor;
    run("structured", structuredCommand, false, function (r) {
      post("structured", { editorType: editor, outcome: r });
      run("presence", presenceCommand, false, function (r2) {
        post("presence", { editorType: editor, outcome: r2 });
        if (info.isViewMode) return;
        indicator(function (ind) { post("indicator", { editorType: editor, outcome: ind }); });
        if (editor === "word") {
          run("edit", wordEditCommand, true, function (r3) { post("edit", { editorType: editor, outcome: r3 }); });
        } else if (editor === "cell") {
          // Tick every 15 s for 10 min so Kevin can double-click a cell (cell edit mode) during some ticks.
          var n = 0;
          var tick = function () {
            n += 1; window.Asc.scope.probeTick = n;
            run("tick", cellTickCommand, true, function (r4) {
              post("tick", { editorType: editor, n: n, outcome: r4 });
              if (n < 40) setTimeout(tick, 15000);
            });
          };
          tick();
        }
      });
    });
  }

  window.Asc.plugin.init = function () { setTimeout(start, 8000); }; // fallback if the ready event never comes
  window.Asc.plugin.event_onDocumentContentReady = function () { setTimeout(start, 1000); };
  window.Asc.plugin.button = function () {};
})(window);
