/**
 * Skills panel, option C: the small client script (ES5, no backticks: it is
 * embedded in a template literal). Everything works without it; it adds the
 * modal create dialog, live search, the file-name hint, the toast text and
 * the wide pane's top offset. Runs on every Turbo render; document-level
 * listeners are bound once.
 */
export function skillsClientJs() {
  return `<script>
(function () {
  var page = document.querySelector(".sk-page");
  if (!page) return;
  function fold(s) { return String(s || "").normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase(); }

  // Toast: the status region starts empty; its text goes in after load so it is announced.
  var toast = document.getElementById("skills-toast");
  if (toast && toast.getAttribute("data-skills-toast")) {
    setTimeout(function () { toast.textContent = toast.getAttribute("data-skills-toast"); }, 60);
    setTimeout(function () { toast.textContent = ""; }, 8000);
  }

  // Create dialog: a real modal (focus trap, Esc) when JS runs; ?new=1 is the no-JS path.
  var dlg = document.getElementById("sk-create");
  function openCreate(name) {
    if (!dlg || typeof dlg.showModal !== "function") return false;
    var nameInput = dlg.querySelector("[name=filename]");
    if (name && nameInput) nameInput.value = name;
    if (!dlg.open) dlg.showModal();
    updateHint();
    var af = dlg.querySelector("[autofocus]") || nameInput;
    if (af) af.focus();
    return true;
  }
  document.querySelectorAll("[data-sk-new]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      var q = a.getAttribute("data-sk-name");
      if (a.id === "" && a.hasAttribute("data-tpl")) q = (document.getElementById("sk-q") || {}).value;
      if (openCreate(q)) e.preventDefault();
    });
  });
  if (dlg) {
    dlg.querySelectorAll("[data-sk-close]").forEach(function (b) { b.addEventListener("click", function () { dlg.close(); }); });
    if (dlg.hasAttribute("data-open-on-load")) openCreate(null);
  }

  // File-name hint: the same fold the server uses ("Café notes" → cafe-notes.md).
  var hint = document.getElementById("sk-file-hint");
  function updateHint() {
    if (!hint || !dlg) return;
    var input = dlg.querySelector("[name=filename]");
    var raw = input ? input.value.trim().replace(/\\.md$/i, "") : "";
    var slug = fold(raw).replace(/\\s+/g, "-").replace(/[^a-z0-9_-]/g, "").replace(/^[-_]+|[-_]+$/g, "");
    var file = slug ? slug + ".md" : (raw ? "skill-1.md" : "…");
    var label = hint.getAttribute("data-label") || "{file}";
    var note = hint.textContent.split(" · ").slice(1).join(" · ");
    hint.textContent = label.replace("{file}", file) + (note ? " · " + note : "");
  }
  if (dlg) { var fi = dlg.querySelector("[name=filename]"); if (fi) fi.addEventListener("input", updateHint); }

  // Live search: filter rows on the folded name, purpose, extension and file.
  var q = document.getElementById("sk-q");
  var live = document.getElementById("sk-nomatch-live");
  function filter() {
    var v = fold(q.value).trim();
    var any = false;
    document.querySelectorAll(".sk-sec").forEach(function (sec) {
      var hits = 0;
      sec.querySelectorAll(".sk-row").forEach(function (row) {
        var ok = !v || (row.getAttribute("data-search") || "").indexOf(v) !== -1;
        row.hidden = !ok;
        if (ok) hits++;
      });
      sec.hidden = !!v && hits === 0;
      if (v && hits) sec.open = true;
      if (hits) any = true;
    });
    if (live) {
      live.hidden = !v || any;
      if (v && !any) {
        var b = live.querySelector("b"), a = live.querySelector("a[data-tpl]");
        if (b) b.textContent = b.getAttribute("data-tpl").replace("{q}", q.value.trim());
        if (a) { a.textContent = a.getAttribute("data-tpl").replace("{q}", q.value.trim()); a.setAttribute("data-sk-name", q.value.trim()); }
      }
    }
    try {
      var u = new URL(location.href);
      if (q.value.trim()) u.searchParams.set("q", q.value.trim()); else u.searchParams.delete("q");
      history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    } catch (e) {}
  }
  if (q && document.querySelector(".sk-sec")) q.addEventListener("input", filter);

  // Wide pane: pin its top to the list's top while the list is on screen.
  function pane() {
    var d = document.querySelector(".sk-page .sk-detail"), list = document.querySelector(".sk-page .sk-list");
    if (!d || !list || window.innerWidth < 769) return;
    var top = Math.max(16, Math.round(list.getBoundingClientRect().top));
    document.querySelector(".sk-page").style.setProperty("--sk-pane-top", top + "px");
  }
  pane();
  if (!window.__skPaneBound) {
    window.__skPaneBound = true;
    document.addEventListener("scroll", pane, true);
    window.addEventListener("resize", pane);
  }
})();
</script>`;
}
