/**
 * Schedule panel: the small client script (ES5, no backticks: it is embedded in a template
 * literal). Everything works without it; it adds the modal create sheet, the browser's zone,
 * the live preview (debounced 250 ms, words → read-back + next 3 runs), the toast, focus on an
 * opened detail, Escape to close it, and the wide pane's top offset. Runs on every Turbo render;
 * document-level listeners are bound once.
 */
export function scheduleClientJs() {
  return `<script>
(function () {
  var page = document.querySelector(".sc-page");
  if (!page) return;

  var toast = document.getElementById("sc-toast");
  if (toast && toast.getAttribute("data-sc-toast")) {
    setTimeout(function () { toast.textContent = toast.getAttribute("data-sc-toast"); }, 60);
    setTimeout(function () { toast.textContent = ""; }, 8000);
  }

  // The browser's zone rides the create form (stored only when it differs from the instance's).
  var zone = "";
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
  document.querySelectorAll("[data-sc-tz]").forEach(function (i) { if (!i.value) i.value = zone; });

  var dlg = document.getElementById("sc-create");
  function focusFirst() {
    var af = dlg.querySelector("[autofocus]") || dlg.querySelector("[name=text]");
    if (af) af.focus();
  }
  function openCreate() {
    if (!dlg || typeof dlg.showModal !== "function") return false;
    if (!dlg.open) dlg.showModal();
    focusFirst();
    return true;
  }
  document.querySelectorAll("[data-sc-new]").forEach(function (a) {
    a.addEventListener("click", function (e) { if (openCreate()) e.preventDefault(); });
  });
  if (dlg) {
    dlg.querySelectorAll("[data-sc-dismiss]").forEach(function (b) { b.addEventListener("click", function () { dlg.close(); }); });
    if (dlg.hasAttribute("data-open-on-load")) openCreate();
  }

  // An opened detail takes focus (its heading; the delete confirm's text; an action's result).
  var target = document.getElementById("sc-confirm-text") || document.getElementById("sc-done") || document.getElementById("sc-detail-h");
  if (target && !(dlg && dlg.hasAttribute("data-open-on-load"))) {
    var focusIt = function () { if (document.activeElement === document.body || !document.activeElement) { try { target.focus(); } catch (e) {} } };
    focusIt();
    if (document.readyState !== "complete") window.addEventListener("load", function () { setTimeout(focusIt, 0); }, { once: true });
    else setTimeout(focusIt, 0);
  } else if (!document.getElementById("sc-detail") && /^#sc-\\d+$/.test(location.hash)) {
    // Back from a closed detail: focus returns to its row.
    var row = document.querySelector(location.hash + " .sc-hit");
    if (row) setTimeout(function () { try { row.focus(); } catch (e) {} }, 0);
  }

  // Live preview: the same parser the server saves with, through the session-gated JSON route.
  var form = document.getElementById("sc-create-form");
  var box = document.getElementById("sc-preview");
  var timer = null, seq = 0;
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function render(p) {
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!p) { box.appendChild(el("p", "sc-muted", box.getAttribute("data-l-empty"))); return; }
    if (!p.ok) { var e = el("p", "sc-note sc-note-err", p.hint || ""); box.appendChild(e); return; }
    var s = el("p", "sc-preview-sum"); s.appendChild(el("b", "", p.summary)); box.appendChild(s);
    box.appendChild(el("p", "sc-muted", box.getAttribute("data-l-next")));
    var ol = el("ol", "sc-next");
    (p.next3 || []).forEach(function (x) { var li = el("li"); var tm = el("time", "", x.text); tm.setAttribute("datetime", x.iso); li.appendChild(tm); ol.appendChild(li); });
    box.appendChild(ol);
  }
  function preview() {
    if (!form || !box) return;
    var when = form.querySelector("[name=when]").value, cron = form.querySelector("[name=cron]").value;
    if (!when.trim() && !cron.trim()) { render(null); return; }
    var mine = ++seq;
    var u = "/dashboard/schedule/preview?when=" + encodeURIComponent(when) + "&cron=" + encodeURIComponent(cron) + "&tz=" + encodeURIComponent(zone) + "&lang=" + encodeURIComponent(box.getAttribute("data-lang") || "en");
    fetch(u, { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) { if (mine === seq && p) render(p); })
      .catch(function () {});
  }
  if (form && box) {
    ["when", "cron"].forEach(function (n) {
      var i = form.querySelector("[name=" + n + "]");
      if (i) i.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(preview, 250); });
    });
  }

  // Escape closes an open detail (not while the sheet is open: the dialog handles its own Escape).
  if (!window.__scEscBound) {
    window.__scEscBound = true;
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      var d = document.getElementById("sc-create");
      if (d && d.open) return;
      var close = document.querySelector(".sc-detail [data-sc-close]");
      if (close) { e.preventDefault(); close.click(); }
    });
  }

  // Wide pane: pin its top to the strip's top while it is on screen.
  function pane() {
    var d = document.querySelector(".sc-page .sc-detail"), top0 = document.querySelector(".sc-page .sc-attn");
    if (!d || !top0 || window.innerWidth < 769) return;
    var top = Math.max(16, Math.round(top0.getBoundingClientRect().top));
    document.querySelector(".sc-page").style.setProperty("--sc-pane-top", top + "px");
  }
  pane();
  if (!window.__scPaneBound) {
    window.__scPaneBound = true;
    document.addEventListener("scroll", pane, true);
    window.addEventListener("resize", pane);
  }
})();
</script>`;
}
