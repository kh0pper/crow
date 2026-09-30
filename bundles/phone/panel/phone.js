const T = {
  en: { title: "Phone", pending: "Waiting for your approval", live: "Live call", history: "History", settings: "Settings",
    business: "This is a business", cloud: "Allow cloud model for this call", totp: "2FA code", approve: "Approve now",
    approveAt: "Approve for", reject: "Reject", stop: "Stop call", says: "Business says…", send: "Send",
    notice: "I understand the assistant places AI-voice calls on my behalf, only to businesses I approve, and discloses that it is automated.",
    ownerName: "Your first name (used in the disclosure)", ownerNumber: "Your phone number (never dialed)",
    localModel: "Local model (provider/model)", cloudModel: "Cloud model (provider/model)", cap: "Daily call limit", save: "Save",
    none: "Nothing here yet.", queued: "Queued", goal: "Goal", limits: "Limits", share: "May share", outcome: "Outcome" },
  es: { title: "Teléfono", pending: "Esperando tu aprobación", live: "Llamada en curso", history: "Historial", settings: "Ajustes",
    business: "Es un negocio", cloud: "Permitir modelo en la nube para esta llamada", totp: "Código 2FA", approve: "Aprobar ahora",
    approveAt: "Aprobar para", reject: "Rechazar", stop: "Colgar", says: "El negocio dice…", send: "Enviar",
    notice: "Entiendo que el asistente hace llamadas con voz de IA en mi nombre, solo a negocios que yo apruebe, y que avisa que es automatizado.",
    ownerName: "Tu nombre (se usa en el aviso)", ownerNumber: "Tu número (nunca se marca)",
    localModel: "Modelo local (proveedor/modelo)", cloudModel: "Modelo en la nube (proveedor/modelo)", cap: "Límite diario de llamadas", save: "Guardar",
    none: "Nada por ahora.", queued: "En cola", goal: "Objetivo", limits: "Límites", share: "Puede compartir", outcome: "Resultado" },
};

export default {
  id: "phone", name: "Phone", icon: "phone", route: "/dashboard/phone", navOrder: 60,
  async handler(req, res, { layout, lang }) {
    const t = T[lang === "es" ? "es" : "en"];
    const L = JSON.stringify(t).replace(/</g, "\\u003c");
    const content = `
<section class="phone-panel">
  <h2>${t.settings}</h2>
  <form id="phone-settings">
    <label>${t.ownerName} <input name="ownerName"></label>
    <label>${t.ownerNumber} <input name="ownerNumber"></label>
    <label>${t.localModel} <input name="localModel" placeholder="crow-local/qwen3.6-35b-a3b"></label>
    <label>${t.cloudModel} <input name="cloudModel" placeholder="qwen-cloud/qwen3.8-flash"></label>
    <label>${t.cap} <input name="dailyCap" type="number" min="1" max="50"></label>
    <label><input type="checkbox" name="tcpaAck"> ${t.notice}</label>
    <label>${t.totp} <input name="totp" inputmode="numeric" maxlength="6"></label>
    <button type="submit">${t.save}</button>
  </form>
  <h2>${t.pending}</h2><div id="phone-pending"></div>
  <h2>${t.live}</h2><div id="phone-live"></div>
  <h2>${t.history}</h2><div id="phone-history"></div>
  <template id="phone-approve-tpl">
    <form class="phone-approve">
      <label><input type="checkbox" name="business_confirmed"> ${t.business}</label>
      <label><input type="checkbox" name="allow_cloud"> ${t.cloud}</label>
      <label>${t.totp} <input name="totp" inputmode="numeric" maxlength="6"></label>
      <label>${t.approveAt} <input type="datetime-local" name="run_after"></label>
      <button name="do" value="approve">${t.approve}</button> <button name="do" value="reject">${t.reject}</button>
    </form>
  </template>
</section>`;
    const scripts = `
(function () {
  var L = ${L};
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function api(method, path, body) {
    return fetch("/api/phone" + path, { method: method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) { alert(j.message || j.error || "error"); throw j; } return j; }); });
  }
  function describe(c) {
    return "<b>" + esc(c.business_name) + "</b> " + esc(c.number_e164) + "<br>" + L.goal + ": " + esc(c.goal) +
      "<br>" + L.limits + ": " + esc(JSON.stringify(c.limits)) + "<br>" + L.share + ": " + esc(Object.keys(c.shareable || {}).join(", "));
  }
  function renderPending(calls) {
    var box = document.getElementById("phone-pending"); box.innerHTML = "";
    var list = calls.filter(function (c) { return c.status === "awaiting_approval"; });
    if (!list.length) { box.textContent = L.none; return; }
    list.forEach(function (c) {
      var div = document.createElement("div"); div.className = "phone-card"; div.innerHTML = describe(c);
      var f = document.getElementById("phone-approve-tpl").content.firstElementChild.cloneNode(true);
      f.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var action = ev.submitter ? ev.submitter.value : "approve";
        if (action === "reject") { api("POST", "/calls/" + c.id + "/reject").then(load); return; }
        var ra = f.run_after.value ? new Date(f.run_after.value).toISOString() : undefined;
        api("POST", "/calls/" + c.id + "/approve", { business_confirmed: f.business_confirmed.checked, allow_cloud: f.allow_cloud.checked, totp: f.totp.value, run_after: ra }).then(load);
      });
      div.appendChild(f); box.appendChild(div);
    });
  }
  function renderLive(calls) {
    var box = document.getElementById("phone-live"); box.innerHTML = "";
    var c = calls.filter(function (x) { return x.status === "live" || x.status === "starting"; })[0];
    if (!c) {
      var q = calls.filter(function (x) { return x.status === "approved"; });
      box.innerHTML = q.length ? q.map(function (x) { return esc(L.queued) + ": " + esc(x.business_name) + (x.run_after ? " (" + esc(x.run_after) + ")" : ""); }).join("<br>") : esc(L.none);
      return;
    }
    var lines = (c.transcript || []).map(function (e) { return "<div class='t-" + esc(e.type) + "'>" + esc(e.type) + ": " + esc(e.text || e.digits || e.state || "") + "</div>"; }).join("");
    box.innerHTML = describe(c) + "<div class='phone-transcript'>" + lines + "</div>" +
      "<form id='phone-farend'><input name='text' placeholder='" + esc(L.says) + "'> <button>" + esc(L.send) + "</button></form>" +
      "<button id='phone-stop'>" + esc(L.stop) + "</button>";
    document.getElementById("phone-stop").onclick = function () { api("POST", "/calls/" + c.id + "/stop").then(load); };
    document.getElementById("phone-farend").onsubmit = function (ev) { ev.preventDefault(); var i = ev.target.text; api("POST", "/calls/" + c.id + "/farend", { text: i.value }).then(function () { i.value = ""; load(); }); };
  }
  function renderHistory(calls) {
    var box = document.getElementById("phone-history");
    var done = calls.filter(function (c) { return c.status === "done" || c.status === "rejected" || c.status === "expired" || c.status === "cancelled"; });
    box.innerHTML = done.length ? done.map(function (c) { return "<div>" + esc(c.business_name) + " — " + esc(c.status) + (c.outcome ? " / " + L.outcome + ": " + esc(c.outcome) : "") + (c.booking ? " — " + esc([c.booking.date, c.booking.time].join(" ")) : "") + "</div>"; }).join("") : esc(L.none);
  }
  function load() { return api("GET", "/calls").then(function (j) { renderPending(j.calls); renderLive(j.calls); renderHistory(j.calls); }); }
  function loadSettings() {
    api("GET", "/settings").then(function (st) { var f = document.getElementById("phone-settings");
      f.ownerName.value = st.ownerName || ""; f.ownerNumber.value = st.ownerNumber || ""; f.localModel.value = st.localModel || "";
      f.cloudModel.value = st.cloudModel || ""; f.dailyCap.value = st.dailyCap || 10; f.tcpaAck.checked = !!st.tcpaAck; f.totp.value = ""; });
  }
  document.getElementById("phone-settings").onsubmit = function (ev) {
    ev.preventDefault(); var f = ev.target;
    api("POST", "/settings", { ownerName: f.ownerName.value, ownerNumber: f.ownerNumber.value || undefined, localModel: f.localModel.value,
      cloudModel: f.cloudModel.value, dailyCap: Number(f.dailyCap.value), tcpaAck: f.tcpaAck.checked || undefined, totp: f.totp.value }).then(loadSettings);
  };
  loadSettings(); load();
  if (window.__crowPhonePoll) clearInterval(window.__crowPhonePoll);
  window.__crowPhonePoll = setInterval(function () { if (!document.getElementById("phone-live")) { clearInterval(window.__crowPhonePoll); return; } load(); }, 1500);
})();`;
    return layout({ title: t.title, content, scripts });
  },
};
