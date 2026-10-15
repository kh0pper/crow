/**
 * Model Catalog — the registered models section (models plan 3a, Task 6).
 *
 * One row per provider the lifecycle listing knows (native own, native on
 * another instance, external engine), rendered from the same snapshot
 * `GET /api/models/registered` answers (models/registered-rows.js). Actions:
 *   Start      only when `startable` (own native row, orchestration on, a
 *              resident-class model) and the row is not running or loading;
 *   Stop       only when resident and orchestration is on;
 *   Edit/Remove only on own native rows — external and foreign rows are
 *              read-only here.
 * Start goes through the shared job store (`POST /api/models/providers/:p/
 * start`, then `GET /api/models/jobs/:id`), the same path the curated cards
 * and the runtime strip use (`window.CrowModelLifecycle`).
 *
 * ABSOLUTE RULE: the client <script> is built inside a template literal and
 * must never contain a backtick. Browser strings are single/double quoted;
 * DOM built from data uses createElement/textContent, never innerHTML.
 */
import { t, tJs, fill } from "../shared/i18n.js";
import { escapeHtml } from "../shared/components.js";

const STATUS_KEYS = {
  resident: "models.regStatusResident",
  stopped: "models.regStatusStopped",
  loading: "models.regStatusLoading",
  blocked_by_reservation: "models.regStatusBlocked",
  external_up: "models.regStatusExternalUp",
  external_down: "models.regStatusExternalDown",
  foreign: "models.regStatusForeign",
};

export function registeredStyles() {
  return `<style>
.mcat-reg {
  background:var(--crow-bg-surface); border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-card, 12px); padding:1rem 1.25rem; margin-bottom:1.5rem;
  min-width:0; max-width:100%; box-sizing:border-box;
}
.mcat-reg__title { font-family:var(--crow-body-font); font-weight:600; font-size:1rem; color:var(--crow-text-primary); margin-bottom:0.35rem; }
.mcat-reg__intro, .mcat-reg__line { font-size:0.82rem; color:var(--crow-text-secondary); line-height:1.5; margin-bottom:0.5rem; }
.mcat-reg__line code { word-break:break-all; }
.mcat-reg__notice { font-size:0.78rem; color:var(--crow-text-muted); background:var(--crow-bg-deep); border-radius:8px; padding:0.5rem 0.75rem; margin:0.5rem 0; }
.mcat-reg__table { width:100%; border-collapse:collapse; font-size:0.82rem; }
.mcat-reg__table th { text-align:left; font-weight:600; color:var(--crow-text-muted); font-size:0.72rem; text-transform:uppercase; letter-spacing:0.03em; padding:0.4rem 0.5rem; border-bottom:1px solid var(--crow-border); }
.mcat-reg__table td { padding:0.5rem; border-bottom:1px solid var(--crow-border); vertical-align:top; color:var(--crow-text-secondary); min-width:0; overflow-wrap:anywhere; }
.mcat-reg__table tr:last-child td { border-bottom:none; }
.mcat-reg__provider { font-family:'JetBrains Mono',monospace; color:var(--crow-text-primary); word-break:break-all; }
.mcat-reg__argv { font-family:'JetBrains Mono',monospace; font-size:0.72rem; word-break:break-all; white-space:normal; }
.mcat-reg__gap { font-size:0.75rem; color:var(--crow-text-muted); }
.mcat-reg__status { font-size:0.68rem; font-weight:600; text-transform:uppercase; letter-spacing:0.03em; padding:0.12rem 0.45rem; border-radius:999px; background:var(--crow-bg-elevated); color:var(--crow-text-secondary); display:inline-block; }
.mcat-reg__status--resident, .mcat-reg__status--external_up { color:var(--crow-success); background:rgba(34,197,94,0.14); }
.mcat-reg__status--loading { color:var(--crow-accent); background:var(--crow-accent-muted); }
.mcat-reg__status--blocked_by_reservation, .mcat-reg__status--external_down { color:var(--crow-warning); background:rgba(245,158,11,0.14); }
.mcat-reg__serving { font-size:0.68rem; font-weight:600; color:var(--crow-warning); }
.mcat-reg__actions { display:flex; gap:0.35rem; flex-wrap:wrap; align-items:center; }
.mcat-reg__msg { font-size:0.75rem; color:var(--crow-text-muted); margin-top:0.35rem; width:100%; }
.mcat-reg__cause { font-family:'JetBrains Mono',monospace; font-size:0.7rem; white-space:pre-wrap; word-break:break-all; background:var(--crow-bg-deep); border-radius:6px; padding:0.4rem 0.55rem; margin:0.35rem 0 0; max-height:12rem; overflow-y:auto; }
@media (max-width:640px) {
  .mcat-reg { padding:0.85rem 0.9rem; }
  .mcat-reg__table, .mcat-reg__table tbody, .mcat-reg__table tr, .mcat-reg__table td { display:block; width:100%; box-sizing:border-box; }
  .mcat-reg__table thead { display:none; }
  .mcat-reg__table tr { border-bottom:1px solid var(--crow-border); padding:0.4rem 0; }
  .mcat-reg__table tr:last-child { border-bottom:none; }
  .mcat-reg__table td { border-bottom:none; padding:0.2rem 0; }
  .mcat-reg__table td[data-label]::before { content:attr(data-label); display:block; font-size:0.66rem; font-weight:600; text-transform:uppercase; letter-spacing:0.03em; color:var(--crow-text-muted); }
}
</style>`;
}

function argvCell(row, lang) {
  if (row.managed === "external") return `<span class="mcat-reg__gap">${escapeHtml(t("models.regArgvExternal", lang))}</span>`;
  if (row.status === "foreign") return `<span class="mcat-reg__gap">${escapeHtml(fill(t("models.regOwnedBy", lang), { owner: row.owner || "?" }))}</span>`;
  if (Array.isArray(row.argv) && row.argv.length) return `<code class="mcat-reg__argv">${escapeHtml(row.argv.join(" "))}</code>`;
  // Stopped: there is no live argv; say so and show what the next start
  // merges over the catalog defaults (review Low).
  if (row.launch && typeof row.launch === "object" && Object.keys(row.launch).length) {
    return `<span class="mcat-reg__gap">${escapeHtml(t("models.regArgvStopped", lang))}</span> <code class="mcat-reg__argv">${escapeHtml(JSON.stringify(row.launch))}</code>`;
  }
  return `<span class="mcat-reg__gap">${escapeHtml(t("models.regArgvDefaults", lang))}</span>`;
}

function actionButtons(row, snapshot, lang) {
  const out = [];
  const p = escapeHtml(row.provider);
  const btn = (action, label, variant) => `<button type="button" class="btn btn-${variant} btn-sm" data-reg-action="${action}" data-provider="${p}">${escapeHtml(label)}</button>`;
  const running = row.status === "resident";
  if (row.startable && !running && row.status !== "loading") out.push(btn("start", t("models.actionStart", lang), "primary"));
  if (running && row.own && !snapshot.orchestrationDisabled) out.push(btn("stop", t("models.actionStop", lang), "secondary"));
  if (row.own && !running && (row.servingClass === "windowed" || row.servingClass === "wedge-risk")) {
    const key = row.servingClass === "wedge-risk" ? "models.servingWedgeRiskBadge" : "models.servingWindowedBadge";
    out.push(`<span class="mcat-reg__serving">${escapeHtml(t(key, lang))}</span>`);
  }
  if (row.own) {
    const editRow = {
      provider: row.provider, catalogId: row.catalogId, quant: row.quant, mutexGroup: row.mutexGroup,
      launch: row.launch, alwaysResident: row.alwaysResident, defaultMember: row.defaultMember, status: row.status, inCatalog: row.inCatalog,
    };
    // Edit re-registers from the catalog, so a model outside it (an
    // hf-browser file) has no edit path here.
    if (row.inCatalog) out.push(`<button type="button" class="btn btn-secondary btn-sm" data-reg-action="edit" data-provider="${p}" data-row="${escapeHtml(JSON.stringify(editRow))}">${escapeHtml(t("models.regActionEdit", lang))}</button>`);
    out.push(btn("remove", t("models.actionRemove", lang), "danger"));
  }
  return out.join("");
}

/** @param {{rows:object[], orchestrationDisabled:boolean, llamaServerBin?:string|null}} snapshot */
export function renderRegisteredSection(snapshot, lang) {
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  const label = (k) => escapeHtml(t(k, lang));
  const notices = [];
  if (snapshot?.orchestrationDisabled) notices.push(`<div class="mcat-reg__notice">${label("models.runtimeOrchestrationDisabled")}</div>`);
  // Read-only: CROW_LLAMA_SERVER_BIN is set outside the dashboard.
  let envLine = "";
  if (snapshot?.llamaServerBin) {
    const [before, after = ""] = t("models.regEnvBin", lang).split("{path}");
    envLine = `<div class="mcat-reg__line">${escapeHtml(before)}<code>${escapeHtml(snapshot.llamaServerBin)}</code>${escapeHtml(after)}</div>`;
  }

  const body = rows.length === 0
    ? `<div class="mcat-reg__line">${label("models.regEmpty")}</div>`
    : `<div class="table-scroll"><table class="mcat-reg__table"><thead><tr>
        <th>${label("models.regColProvider")}</th><th>${label("models.regColModel")}</th><th>${label("models.regColStatus")}</th>
        <th>${label("models.regColGroup")}</th><th>${label("models.regColArgv")}</th><th>${label("models.regColActions")}</th>
      </tr></thead><tbody>${rows.map((row) => {
        const status = STATUS_KEYS[row.status] ? row.status : "stopped";
        const model = [row.model || row.catalogId || "?", row.quant].filter(Boolean).join(" · ");
        return `<tr data-provider-row="${escapeHtml(row.provider)}" data-status="${escapeHtml(status)}">
          <td data-label="${label("models.regColProvider")}"><span class="mcat-reg__provider">${escapeHtml(row.provider)}</span></td>
          <td data-label="${label("models.regColModel")}">${escapeHtml(model)}</td>
          <td data-label="${label("models.regColStatus")}"><span class="mcat-reg__status mcat-reg__status--${escapeHtml(status)}">${label(STATUS_KEYS[status])}</span></td>
          <td data-label="${label("models.regColGroup")}">${row.mutexGroup ? escapeHtml(row.mutexGroup) : label("models.regNoGroup")}</td>
          <td data-label="${label("models.regColArgv")}">${argvCell(row, lang)}</td>
          <td data-label="${label("models.regColActions")}"><div class="mcat-reg__actions">${actionButtons(row, snapshot || {}, lang)}</div><div class="mcat-reg__msg" data-provider-msg="${escapeHtml(row.provider)}"></div></td>
        </tr>`;
      }).join("")}</tbody></table></div>`;

  return `${registeredStyles()}<section class="mcat-reg" id="mcat-registered">
    <div class="mcat-reg__title">${label("models.regHeading")}</div>
    <div class="mcat-reg__intro">${label("models.regIntro")}</div>
    ${notices.join("")}
    ${envLine}
    ${body}
  </section>`;
}

// ---------------------------------------------------------------------------
// Client script — NO BACKTICKS below, inside the returned template literal.
// ---------------------------------------------------------------------------

export function registeredClientJS(lang) {
  return `
    <script>
      (function () {
        var API = "/api/models";
        var T = {
          starting: '${tJs("models.regStarting", lang)}',
          evicting: '${tJs("models.regEvicting", lang)}',
          stopping: '${tJs("models.regStopping", lang)}',
          resident: '${tJs("models.regStatusResident", lang)}',
          startFailed: '${tJs("models.regStartFailed", lang)}',
          blocked: '${tJs("models.regBlocked", lang)}',
          failed: '${tJs("models.regFailed", lang)}',
          restartToApply: '${tJs("models.regRestartToApply", lang)}',
          removeTitle: '${tJs("models.regRemoveTitle", lang)}',
          removeBindings: '${tJs("models.regRemoveBindings", lang)}',
          removeNoBindings: '${tJs("models.regRemoveNoBindings", lang)}',
          removeConfirm: '${tJs("models.regRemoveConfirm", lang)}',
          cancel: '${tJs("models.deleteCancelButton", lang)}'
        };

        function csrf() {
          var m = (document.cookie || "").match(/(?:^|;\\s*)crow_csrf=([^;]*)/);
          return m ? decodeURIComponent(m[1]) : "";
        }
        function fill(s, p) {
          var out = String(s);
          for (var k in p) out = out.split("{" + k + "}").join(String(p[k]));
          return out;
        }
        function call(method, path) {
          var headers = { "Content-Type": "application/json" };
          if (method !== "GET") headers["X-Crow-Csrf"] = csrf();
          return fetch(API + path, { method: method, headers: headers }).then(function (r) {
            return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d || {} }; },
              function () { return { ok: r.ok, status: r.status, data: {} }; });
          });
        }
        function errText(d) {
          d = d || {};
          return (d.code ? d.code + ": " : "") + (d.error || T.failed);
        }
        /** Text plus optional stderr lines, never parsed as markup. */
        function show(el, text, lines) {
          if (!el) return;
          el.replaceChildren();
          var p = document.createElement("div");
          p.textContent = text;
          el.appendChild(p);
          if (lines && lines.length) {
            var pre = document.createElement("pre");
            pre.className = "mcat-reg__cause";
            pre.textContent = lines.join("\\n");
            el.appendChild(pre);
          }
        }

        function pollJob(id, el) {
          call("GET", "/jobs/" + encodeURIComponent(id)).then(function (res) {
            var j = res.data || {};
            if (!res.ok) { show(el, errText(j)); return; }
            if (j.state === "resident") { show(el, T.resident); location.reload(); return; }
            if (j.state === "failed") {
              show(el, fill(T.startFailed, { error: j.error || "" }), Array.isArray(j.cause) ? j.cause : []);
              return;
            }
            if (j.state === "blocked_by_reservation") {
              var r = j.reservation || {};
              show(el, fill(T.blocked, { owner: r.owner || "?", expires: r.expires_at || "?" }));
              return;
            }
            show(el, j.state === "evicting" ? T.evicting : T.starting);
            setTimeout(function () { pollJob(id, el); }, 1500);
          }).catch(function () {
            setTimeout(function () { pollJob(id, el); }, 3000);
          });
        }

        function start(provider, el) {
          show(el, T.starting);
          return call("POST", "/providers/" + encodeURIComponent(provider) + "/start").then(function (res) {
            if (res.status === 202 && res.data && res.data.job_id) pollJob(res.data.job_id, el);
            else show(el, errText(res.data));
          }).catch(function () { show(el, T.failed); });
        }

        function stop(provider, el) {
          show(el, T.stopping);
          return call("POST", "/providers/" + encodeURIComponent(provider) + "/stop").then(function (res) {
            if (res.ok) location.reload();
            else show(el, errText(res.data));
          }).catch(function () { show(el, T.failed); });
        }

        // One start/stop path for every panel button (curated cards and the
        // runtime strip call this too).
        window.CrowModelLifecycle = { start: start, stop: stop, show: show };

        function overlay() { return document.getElementById("mcat-modal-overlay"); }
        function hideModal() { var o = overlay(); if (o) o.style.display = "none"; }

        function confirmRemove(provider, bindings, el) {
          var n = ((bindings && bindings.profiles) || []).length + ((bindings && bindings.bots) || []).length;
          var box = document.createElement("div");
          var title = document.createElement("div");
          title.className = "mcat-modal__title";
          title.textContent = fill(T.removeTitle, { provider: provider });
          box.appendChild(title);
          var p = document.createElement("p");
          p.textContent = n > 0 ? fill(T.removeBindings, { n: n }) : T.removeNoBindings;
          box.appendChild(p);
          var actions = document.createElement("div");
          actions.className = "mcat-modal__actions";
          var cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "btn btn-secondary btn-sm";
          cancel.textContent = T.cancel;
          cancel.addEventListener("click", hideModal);
          actions.appendChild(cancel);
          var ok = document.createElement("button");
          ok.type = "button";
          ok.className = "btn btn-danger btn-sm";
          ok.setAttribute("data-reg-confirm", "remove");
          ok.textContent = T.removeConfirm;
          ok.addEventListener("click", function () {
            ok.disabled = true;
            call("DELETE", "/providers/" + encodeURIComponent(provider) + "?confirm=true").then(function (res) {
              hideModal();
              if (res.ok) location.reload();
              else show(el, errText(res.data));
            }).catch(function () { hideModal(); show(el, T.failed); });
          });
          actions.appendChild(ok);
          box.appendChild(actions);
          var mc = document.getElementById("mcat-modal-content");
          if (!mc) return;
          mc.replaceChildren();
          mc.appendChild(box);
          var o = overlay();
          if (o) o.style.display = "flex";
        }

        function requestRemove(provider, el) {
          call("DELETE", "/providers/" + encodeURIComponent(provider)).then(function (res) {
            if (res.ok && res.data && res.data.requiresConfirm) confirmRemove(provider, res.data.bindings, el);
            else if (!res.ok) show(el, errText(res.data));
          }).catch(function () { show(el, T.failed); });
        }

        document.addEventListener("click", function (e) {
          var b = e.target && e.target.closest ? e.target.closest("[data-reg-action]") : null;
          if (!b) return;
          var provider = b.getAttribute("data-provider");
          var action = b.getAttribute("data-reg-action");
          var el = document.querySelector('[data-provider-msg="' + provider + '"]');
          if (action === "start") start(provider, el);
          else if (action === "stop") stop(provider, el);
          else if (action === "remove") requestRemove(provider, el);
          else if (action === "edit") {
            var row = null;
            try { row = JSON.parse(b.getAttribute("data-row") || "null"); } catch (err) { row = null; }
            if (row && window.CrowModelDialog) window.CrowModelDialog.open({ mode: "edit", row: row });
          }
        });

        // After an edit of a running model the dialog leaves a note: the
        // change applies on the next start.
        try {
          var edited = JSON.parse(sessionStorage.getItem("mcat-edited") || "[]");
          sessionStorage.removeItem("mcat-edited");
          (Array.isArray(edited) ? edited : []).forEach(function (provider) {
            var tr = document.querySelector('[data-provider-row="' + provider + '"]');
            if (tr && tr.getAttribute("data-status") === "resident") {
              show(document.querySelector('[data-provider-msg="' + provider + '"]'), T.restartToApply);
            }
          });
        } catch (err) { /* storage unavailable: no note */ }
      })();
    </script>`;
}
