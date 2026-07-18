export default {
  id: "rookery",
  name: "Open Science Reviewer",
  icon: "search",
  route: "/dashboard/rookery",
  navOrder: 62,
  category: "ai",
  async handler(req, res, { layout }) {
    const content = `
<div class="panel-page">
  <h2>Open Science Reviewer</h2>
  <p>Assemble an experiment report + its evidence into an audit workspace, then
     open the blind reviewer on it.
     <a id="rk-reviewer-link" href="http://127.0.0.1:3061/" target="_blank" rel="noopener">Open reviewer ↗</a>
     <small>(served at your ROOKERY_REVIEWER_URL — see the bundle README for
     root-origin serving options)</small></p>
  <h3>Assemble a workspace</h3>
  <form id="rk-form">
    <label>Report path <input name="report" required placeholder="/path/to/REPORT.md"></label>
    <label>Data dir <input name="dataDir" required placeholder="/path/to/data-dir"></label>
    <label>Phases (space-separated) <input name="phases" required placeholder="exp-1 exp-1-baseline"></label>
    <label>Workspace name <input name="name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"></label>
    <button type="submit">Assemble</button>
  </form>
  <pre id="rk-result"></pre>
  <h3>Workspaces</h3>
  <ul id="rk-list"><li>Loading…</li></ul>
</div>
<script>
(function () {
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  function refresh() {
    fetch("/api/rookery/workspaces").then(function (r) { return r.json(); }).then(function (d) {
      var url = d.reviewerUrl || "http://127.0.0.1:3061/";
      document.getElementById("rk-reviewer-link").href = url;
      var el = document.getElementById("rk-list");
      if (!d.workspaces.length) { el.innerHTML = "<li>None yet.</li>"; return; }
      el.innerHTML = d.workspaces.map(function (w) {
        return "<li><code>" + esc(w.name) + "</code>" +
          (w.hasManifest ? "" : " (no manifest!)") +
          " — open <a href='" + esc(url) + "' target='_blank' rel='noopener'>reviewer</a>" +
          " and pick <code>" + esc(w.containerPath) + "</code></li>";
      }).join("");
    });
  }
  document.getElementById("rk-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = new FormData(e.target);
    fetch("/api/rookery/assemble", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        report: f.get("report"), dataDir: f.get("dataDir"),
        phases: String(f.get("phases")).trim().split(/\s+/), name: f.get("name"),
      }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      document.getElementById("rk-result").textContent = JSON.stringify(d, null, 2);
      refresh();
    });
  });
  refresh();
})();
</script>`;
    res.send(layout({ title: "Open Science Reviewer", content }));
  },
};
