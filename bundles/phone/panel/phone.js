const T = {
  en: { title: "Phone", pending: "Waiting for your approval", live: "Live call", history: "History", settings: "Settings",
    business: "This is a business", cloud: "Allow cloud model for this call", totp: "2FA code", approve: "Approve now",
    approveAt: "Approve for", reject: "Reject", stop: "Hang up", says: "Business says…", send: "Send",
    notice: "I understand the assistant places AI-voice calls on my behalf, only to businesses I approve, and discloses that it is automated.",
    ownerName: "Your first name (used in the disclosure)", ownerNumber: "Your phone number (never dialed)",
    localModel: "Local model (provider/model)", cloudModel: "Cloud model (provider/model)", cap: "Daily call limit", save: "Save",
    none: "Nothing here yet.", queued: "Queued", goal: "Goal", limits: "Limits", share: "May share", outcome: "Outcome",
    noLimits: "none", dates: "dates", days: "days", hours: "hours", maxPrice: "max price", duration: "duration", minutes: "min", limitNotes: "notes",
    editShare: "Edit what may be shared (clear a field to withhold it)", cloudIs: "cloud model", noCloud: "no cloud model configured",
    proposed: "Proposed time",
    pollLost: "Lost touch with Phone — updates stopped.", retry: "Retry",
    // Backlog P6: the routes' refusal codes, in the owner's language.
    errors: { local_login_required: "Sign in on this Crow with your password to do this (peer sign-in is not enough).",
      totp_required: "Enter your current 2FA code.", business_confirmation_required: "Tick \u201cThis is a business\u201d first.",
      notice_not_acknowledged: "Acknowledge the AI-call notice in Phone settings first.",
      owner_name_required: "Set your first name in Phone settings first (the assistant says who it is calling for).",
      invalid_run_after: "That is not a valid date and time.", plan_changed: "The plan changed — review it again before approving.",
      not_pending: "This call is no longer waiting for approval.", not_editable: "This call can no longer be edited.",
      not_live: "This call is not live any more.", not_found: "This call no longer exists.", invalid_plan: "The call plan is not valid.",
      invalid_model: "Model must be \u201cprovider/model\u201d with an existing, enabled provider (the local model cannot use a cloud provider).",
      rate_limited: "Too many call plans from this bot right now.", empty: "Type what the business said first." },
    outcomes: { booked: "Booked", info_gathered: "Got the info", needs_callback: "Needs a callback", no_answer: "No answer",
      voicemail: "Reached voicemail", busy: "Line busy", not_in_service: "Number not in service", refused: "Business declined",
      phone_busy: "Your phone was busy", phone_unreachable: "Phone not reachable", line_lost: "Call moved to your phone",
      taken_over: "You took over the call", not_admissible: "Could not start", stopped: "Stopped by you", failed: "Failed" } },
  es: { title: "Teléfono", pending: "Esperando tu aprobación", live: "Llamada en curso", history: "Historial", settings: "Ajustes",
    business: "Es un negocio", cloud: "Permitir modelo en la nube para esta llamada", totp: "Código 2FA", approve: "Aprobar ahora",
    approveAt: "Aprobar para", reject: "Rechazar", stop: "Colgar", says: "El negocio dice…", send: "Enviar",
    notice: "Entiendo que el asistente hace llamadas con voz de IA en mi nombre, solo a negocios que yo apruebe, y que avisa que es automatizado.",
    ownerName: "Tu nombre (se usa en el aviso)", ownerNumber: "Tu número (nunca se marca)",
    localModel: "Modelo local (proveedor/modelo)", cloudModel: "Modelo en la nube (proveedor/modelo)", cap: "Límite diario de llamadas", save: "Guardar",
    none: "Nada por ahora.", queued: "En cola", goal: "Objetivo", limits: "Límites", share: "Puede compartir", outcome: "Resultado",
    noLimits: "ninguno", dates: "fechas", days: "días", hours: "horario", maxPrice: "precio máximo", duration: "duración", minutes: "min", limitNotes: "notas",
    editShare: "Edita lo que se puede compartir (vacía un campo para no compartirlo)", cloudIs: "modelo en la nube", noCloud: "no hay modelo en la nube configurado",
    proposed: "Hora propuesta",
    pollLost: "Se perdió el contacto con Teléfono — ya no se actualiza.", retry: "Reintentar",
    errors: { local_login_required: "Inicia sesión en este Crow con tu contraseña para hacer esto (el inicio de sesión de un par no basta).",
      totp_required: "Escribe tu código 2FA actual.", business_confirmation_required: "Marca primero \u201cEs un negocio\u201d.",
      notice_not_acknowledged: "Primero acepta el aviso de llamadas con IA en los ajustes de Teléfono.",
      owner_name_required: "Primero pon tu nombre en los ajustes de Teléfono (el asistente dice de parte de quién llama).",
      invalid_run_after: "Esa no es una fecha y hora válida.", plan_changed: "El plan cambió — revísalo de nuevo antes de aprobar.",
      not_pending: "Esta llamada ya no espera aprobación.", not_editable: "Esta llamada ya no se puede editar.",
      not_live: "Esta llamada ya no está en curso.", not_found: "Esta llamada ya no existe.", invalid_plan: "El plan de la llamada no es válido.",
      invalid_model: "El modelo debe ser \u201cproveedor/modelo\u201d con un proveedor existente y activo (el modelo local no puede usar un proveedor en la nube).",
      rate_limited: "Demasiados planes de llamada de este bot por ahora.", empty: "Primero escribe lo que dijo el negocio." },
    outcomes: { booked: "Cita reservada", info_gathered: "Información obtenida", needs_callback: "Hay que volver a llamar", no_answer: "No contestaron",
      voicemail: "Buzón de voz", busy: "Línea ocupada", not_in_service: "Número fuera de servicio", refused: "El negocio se negó",
      phone_busy: "Tu teléfono estaba ocupado", phone_unreachable: "Teléfono no disponible", line_lost: "La llamada pasó a tu teléfono",
      taken_over: "Tomaste la llamada", not_admissible: "No se pudo iniciar", stopped: "Detenida por ti", failed: "Falló" } },
};

export { T as PHONE_STRINGS };

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
  <p id="phone-lost" hidden>${t.pollLost} <button type="button" id="phone-retry">${t.retry}</button></p>
  <h2>${t.pending}</h2><div id="phone-pending"></div>
  <h2>${t.live}</h2><div id="phone-live"></div>
  <h2>${t.history}</h2><div id="phone-history"></div>
  <template id="phone-approve-tpl">
    <form class="phone-approve">
      <label><input type="checkbox" name="business_confirmed"> ${t.business}</label>
      <fieldset class="phone-share-edit"><legend>${t.editShare}</legend></fieldset>
      <label><input type="checkbox" name="allow_cloud"> ${t.cloud} <span class="phone-cloud-model"></span></label>
      <label>${t.totp} <input name="totp" inputmode="numeric" maxlength="6"></label>
      <label>${t.approveAt} <input type="datetime-local" name="run_after"></label>
      <button name="do" value="approve">${t.approve}</button> <button name="do" value="reject">${t.reject}</button>
    </form>
  </template>
</section>`;
    const scripts = "(function () {" +
      "  var L = " + L + ";" +
      "  var lastPendingKey = null;" +
      "  var cloudModelSpec = '';" +
      "  var lastLiveCallId = null;" +
      "  var pollFails = 0, pollStopped = false, pollOwner = {};" +
      "  function errText(j) { j = j || {}; return (j.error && Object.prototype.hasOwnProperty.call(L.errors, j.error)) ? L.errors[j.error] : (j.message || j.error || 'error'); }" +
      "  function esc(s) { return String(s == null ? '' : s).replace(/[&<>\"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]; }); }" +
      "  function api(method, path, body, opts) {" +
      "    opts = opts || {};" +
      "    return fetch('/api/phone' + path, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })" +
      "      .then(function (r) { return r.json().then(function (j) { if (!r.ok) { if (!opts.quiet) alert(errText(j)); var err = new Error(j.message || j.error || 'error'); err.status = r.status; err.data = j; throw err; } return j; }); });" +
      "  }" +
      "  function fmtLimits(l) {" +
      "    l = l || {}; var out = [];" +
      "    if (l.date_range) out.push(L.dates + ' ' + l.date_range.from + ' – ' + l.date_range.to);" +
      "    if (l.days_of_week && l.days_of_week.length) out.push(L.days + ' ' + l.days_of_week.join(', '));" +
      "    if (l.time_window) out.push(L.hours + ' ' + l.time_window.start + '–' + l.time_window.end + ' ' + (l.time_window.tz || ''));" +
      "    if (l.max_price) out.push(L.maxPrice + ' ' + l.max_price.amount + ' ' + (l.max_price.currency || ''));" +
      "    if (l.duration_minutes) out.push(L.duration + ' ' + l.duration_minutes + ' ' + L.minutes);" +
      "    if (l.notes) out.push(L.limitNotes + ': ' + l.notes);" +
      "    return out.length ? out.join('; ') : L.noLimits;" +
      "  }" +
      "  function localInput(iso) {" +
      "    if (!iso) return '';" +
      "    var d = new Date(iso); if (isNaN(d.getTime())) return '';" +
      "    function p(n) { return (n < 10 ? '0' : '') + n; }" +
      "    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());" +
      "  }" +
      "  function fmtWhen(iso) { var d = new Date(iso); return isNaN(d.getTime()) ? String(iso) : d.toLocaleString(); }" +
      "  function describe(c) {" +
      "    var sh = c.shareable || {};" +
      "    var shared = Object.keys(sh).map(function (k) { return '<li>' + esc(k) + ': ' + esc(sh[k]) + '</li>'; }).join('');" +
      "    return '<b>' + esc(c.business_name) + '</b> ' + esc(c.number_e164) + '<br>' + esc(L.goal) + ': ' + esc(c.goal) +" +
      "      (c.run_after ? '<br>' + esc(L.proposed) + ': ' + esc(fmtWhen(c.run_after)) : '') +" +
      "      '<br>' + esc(L.limits) + ': ' + esc(fmtLimits(c.limits)) + '<br>' + esc(L.share) + ':' + (shared ? '<ul class=\\'phone-share\\'>' + shared + '</ul>' : ' ' + esc(L.noLimits));" +
      "  }" +
      "  function renderPending(calls) {" +
      "    var list = calls.filter(function (c) { return c.status === 'awaiting_approval'; });" +
      "    var key = list.map(function (c) { return c.id + ':' + c.plan_hash; }).join(',');" +
      "    if (key === lastPendingKey) return;" +
      "    lastPendingKey = key;" +
      "    var box = document.getElementById('phone-pending'); box.innerHTML = '';" +
      "    if (!list.length) { box.textContent = L.none; return; }" +
      "    list.forEach(function (c) {" +
      "      var div = document.createElement('div'); div.className = 'phone-card'; div.innerHTML = describe(c);" +
      "      var f = document.getElementById('phone-approve-tpl').content.firstElementChild.cloneNode(true);" +
      "      var sh = c.shareable || {}; var keys = Object.keys(sh); var fs = f.querySelector('.phone-share-edit');" +
      "      if (!keys.length) fs.remove(); else keys.forEach(function (k) {" +
      "        var lab = document.createElement('label'); lab.textContent = k + ' ';" +
      "        var ta = document.createElement('textarea'); ta.name = 'share_' + k; ta.rows = 1; ta.maxLength = 200; ta.value = sh[k];" +
      "        lab.appendChild(ta); fs.appendChild(lab);" +
      "      });" +
      "      f.run_after.value = localInput(c.run_after);" +
      "      f.querySelector('.phone-cloud-model').textContent = '(' + (cloudModelSpec ? L.cloudIs + ': ' + cloudModelSpec : L.noCloud) + ')';" +
      "      f.addEventListener('submit', function (ev) {" +
      "        ev.preventDefault();" +
      "        var action = ev.submitter ? ev.submitter.value : 'approve';" +
      "        if (action === 'reject') { api('POST', '/calls/' + c.id + '/reject').then(load).catch(function () {}); return; }" +
      "        var ra = f.run_after.value ? new Date(f.run_after.value).toISOString() : null;" +
      "        var body = { plan_hash: c.plan_hash, business_confirmed: f.business_confirmed.checked, allow_cloud: f.allow_cloud.checked, totp: f.totp.value, run_after: ra };" +
      "        if (keys.length) { var edited = {}; keys.forEach(function (k) { edited[k] = f.elements['share_' + k].value; }); body.edits = { shareable: edited }; }" +
      "        api('POST', '/calls/' + c.id + '/approve', body).then(load).catch(function (e) { if (e.status === 409 && e.data && e.data.error === 'plan_changed') { lastPendingKey = null; load(); } });" +
      "      });" +
      "      div.appendChild(f); box.appendChild(div);" +
      "    });" +
      "  }" +
      "  function renderLive(calls) {" +
      "    var box = document.getElementById('phone-live');" +
      "    var c = calls.filter(function (x) { return x.status === 'live' || x.status === 'starting'; })[0];" +
      "    if (!c) {" +
      "      if (lastLiveCallId !== null) { lastLiveCallId = null; box.innerHTML = ''; }" +
      "      var q = calls.filter(function (x) { return x.status === 'approved'; });" +
      "      if (!q.length) { box.textContent = L.none; return; }" +
      "      box.innerHTML = q.map(function (x) { return esc(L.queued) + ': ' + esc(x.business_name) + (x.run_after ? ' (' + esc(x.run_after) + ')' : ''); }).join('<br>');" +
      "      return;" +
      "    }" +
      "    if (c.id === lastLiveCallId) {" +
      "      var transcript = document.querySelector('.phone-transcript');" +
      "      if (transcript) {" +
      "        var lines = (c.transcript || []).map(function (e) { return '<div class=\\'t-' + esc(e.type) + '\\'>' + esc(e.type) + ': ' + esc(e.text || e.digits || e.state || '') + '</div>'; }).join('');" +
      "        transcript.innerHTML = lines;" +
      "      }" +
      "      return;" +
      "    }" +
      "    lastLiveCallId = c.id;" +
      "    var lines = (c.transcript || []).map(function (e) { return '<div class=\\'t-' + esc(e.type) + '\\'>' + esc(e.type) + ': ' + esc(e.text || e.digits || e.state || '') + '</div>'; }).join('');" +
      "    box.innerHTML = describe(c) + '<div class=\\'phone-transcript\\'>' + lines + '</div>' +" +
      "      '<form id=\\'phone-farend\\'><input name=\\'text\\' placeholder=\\'' + esc(L.says) + '\\'> <button>' + esc(L.send) + '</button></form>' +" +
      "      '<button id=\\'phone-stop\\'>' + esc(L.stop) + '</button>';" +
      "    document.getElementById('phone-stop').onclick = function () { api('POST', '/calls/' + c.id + '/stop').then(load).catch(function () {}); };" +
      "    document.getElementById('phone-farend').onsubmit = function (ev) { ev.preventDefault(); var i = ev.target.text; api('POST', '/calls/' + c.id + '/farend', { text: i.value }).then(function () { i.value = ''; load(); }).catch(function () {}); };" +
      "  }" +
      "  function renderHistory(calls) {" +
      "    var box = document.getElementById('phone-history');" +
      "    var done = calls.filter(function (c) { return c.status === 'done' || c.status === 'rejected' || c.status === 'expired' || c.status === 'cancelled'; });" +
      "    box.innerHTML = done.length ? done.map(function (c) { return '<div>' + esc(c.business_name) + ' — ' + esc(c.status) + (c.outcome ? ' / ' + L.outcome + ': ' + esc(L.outcomes[c.outcome] || c.outcome) : '') + (c.booking ? ' — ' + esc([c.booking.date, c.booking.time].join(' ')) : '') + (c.summary ? '<br>' + esc(c.summary) : '') + '</div>'; }).join('') : esc(L.none);" +
      "  }" +
      "  function stopPoll() { pollStopped = true; if (window.__crowPhonePoll) { clearTimeout(window.__crowPhonePoll); window.__crowPhonePoll = null; } }" +
      "  function load() { return api('GET', '/calls', null, { quiet: true }).then(function (j) { pollFails = 0; renderPending(j.calls); renderLive(j.calls); renderHistory(j.calls); }).catch(function (e) { if (e.status === 401) { stopPoll(); return; } pollFails++; }); }" +
      "  function pollDelay() { return pollFails ? Math.min(1500 * Math.pow(2, pollFails), 30000) : 1500; }" +
      "  function schedule() { if (window.__crowPhonePoll) clearTimeout(window.__crowPhonePoll); window.__crowPhonePoll = setTimeout(tick, pollDelay()); }" +
      "  function tick() {" +
      "    window.__crowPhonePoll = null;" +
      "    if (!document.getElementById('phone-live') || pollStopped || window.__crowPhonePollOwner !== pollOwner) return;" +
      "    load().then(function () {" +
      "      if (pollStopped || !document.getElementById('phone-live') || window.__crowPhonePollOwner !== pollOwner) return;" +
      "      if (pollFails >= 5) { document.getElementById('phone-lost').hidden = false; return; }" +
      "      schedule();" +
      "    });" +
      "  }" +
      "  document.getElementById('phone-retry').onclick = function () { pollFails = 0; document.getElementById('phone-lost').hidden = true; tick(); };" +
      "  function loadSettings() {" +
      "    api('GET', '/settings', null, { quiet: true }).then(function (st) { var f = document.getElementById('phone-settings');" +
      "      f.ownerName.value = st.ownerName || ''; f.ownerNumber.value = st.ownerNumber || ''; f.localModel.value = st.localModel || '';" +
      "      f.cloudModel.value = st.cloudModel || ''; if ((st.cloudModel || '') !== cloudModelSpec) { cloudModelSpec = st.cloudModel || ''; lastPendingKey = null; load(); } f.dailyCap.value = st.dailyCap || 10; f.tcpaAck.checked = !!st.tcpaAck; f.totp.value = ''; }).catch(function (e) { if (e.status === 401) stopPoll(); });" +
      "  }" +
      "  document.getElementById('phone-settings').onsubmit = function (ev) {" +
      "    ev.preventDefault(); var f = ev.target;" +
      "    api('POST', '/settings', { ownerName: f.ownerName.value, ownerNumber: f.ownerNumber.value || undefined, localModel: f.localModel.value," +
      "      cloudModel: f.cloudModel.value, dailyCap: Number(f.dailyCap.value), tcpaAck: f.tcpaAck.checked || undefined, totp: f.totp.value }).then(loadSettings).catch(function () {});" +
      "  };" +
      "  if (window.__crowPhonePoll) { clearTimeout(window.__crowPhonePoll); clearInterval(window.__crowPhonePoll); window.__crowPhonePoll = null; }" +
      "  window.__crowPhonePollOwner = pollOwner;" +
      "  loadSettings(); tick();" +
      "})();";
    return layout({ title: t.title, content, scripts });
  },
};
