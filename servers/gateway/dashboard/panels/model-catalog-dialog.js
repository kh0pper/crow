/**
 * Model Catalog — the register / adopt / edit / hf-adopt dialog (models plan
 * 3a, Task 7). `window.CrowModelDialog.open(opts)` builds the form inside the
 * page's existing `#mcat-modal-overlay` (createElement/textContent only).
 *
 *   register  "Register as…" on a registered curated card: another provider
 *             id / group / launch for the same catalog model → POST /register
 *   adopt     "Adopt" on an unregistered card: weights already on disk
 *             → POST /adopt (path, one path per catalog companion kind,
 *             optional size-only match)
 *   edit      "Edit" on a registered row: same as register with the
 *             provider id locked → POST /register under that id
 *   hf-adopt  "Adopt" on a Hugging Face search file → POST /hf-adopt
 *
 * Server errors are shown verbatim (code, message, every `errors[]` entry)
 * and the dialog stays open. Invalid launch JSON sends nothing.
 *
 * ABSOLUTE RULE: no backticks inside the returned <script>.
 */
import { tJs } from "../shared/i18n.js";

export function dialogClientJS(lang) {
  return `
    <style>
      .mcat-dlg__field { display:flex; flex-direction:column; gap:0.25rem; margin-bottom:0.7rem; min-width:0; }
      .mcat-dlg__field label { font-size:0.78rem; font-weight:600; color:var(--crow-text-secondary); }
      .mcat-dlg__field input[type="text"], .mcat-dlg__field select, .mcat-dlg__field textarea {
        width:100%; box-sizing:border-box; min-width:0; padding:0.4rem 0.55rem;
        border:1px solid var(--crow-border); border-radius:6px; background:var(--crow-bg-deep);
        color:var(--crow-text-primary); font-size:0.82rem; font-family:'JetBrains Mono',monospace;
      }
      .mcat-dlg__field textarea { min-height:4.5rem; resize:vertical; }
      .mcat-dlg__check { display:flex; gap:0.45rem; align-items:flex-start; font-size:0.8rem; color:var(--crow-text-secondary); margin-bottom:0.55rem; }
      .mcat-dlg__hint { font-size:0.72rem; color:var(--crow-text-muted); }
      .mcat-dlg__error { font-size:0.78rem; color:var(--crow-error); margin:0.4rem 0; overflow-wrap:anywhere; }
      .mcat-dlg__error ul { margin:0.25rem 0 0 1rem; padding:0; }
    </style>
    <script>
      (function () {
        var API = "/api/models";
        var T = {
          titleRegister: '${tJs("models.dlgTitleRegister", lang)}',
          titleAdopt: '${tJs("models.dlgTitleAdopt", lang)}',
          titleEdit: '${tJs("models.dlgTitleEdit", lang)}',
          titleHfAdopt: '${tJs("models.dlgTitleHfAdopt", lang)}',
          providerId: '${tJs("models.dlgProviderId", lang)}',
          providerIdHint: '${tJs("models.dlgProviderIdHint", lang)}',
          quant: '${tJs("models.dlgQuant", lang)}',
          group: '${tJs("models.dlgMutexGroup", lang)}',
          groupAuto: '${tJs("models.dlgGroupAuto", lang)}',
          groupNone: '${tJs("models.dlgGroupNone", lang)}',
          resident: '${tJs("models.dlgAlwaysResident", lang)}',
          defaultMember: '${tJs("models.dlgDefaultMember", lang)}',
          launch: '${tJs("models.dlgLaunch", lang)}',
          launchHint: '${tJs("models.dlgLaunchHint", lang)}',
          path: '${tJs("models.dlgPath", lang)}',
          companion: '${tJs("models.dlgCompanion", lang)}',
          unverified: '${tJs("models.dlgUnverified", lang)}',
          hashHint: '${tJs("models.dlgHashHint", lang)}',
          save: '${tJs("models.dlgSave", lang)}',
          saving: '${tJs("models.dlgSaving", lang)}',
          badJson: '${tJs("models.dlgBadJson", lang)}',
          cancel: '${tJs("models.deleteCancelButton", lang)}',
          failed: '${tJs("models.regFailed", lang)}'
        };

        function csrf() {
          var m = (document.cookie || "").match(/(?:^|;\\s*)crow_csrf=([^;]*)/);
          return m ? decodeURIComponent(m[1]) : "";
        }
        function call(method, path, body) {
          var headers = { "Content-Type": "application/json" };
          if (method !== "GET") headers["X-Crow-Csrf"] = csrf();
          var init = { method: method, headers: headers };
          if (body !== undefined) init.body = JSON.stringify(body);
          return fetch(API + path, init).then(function (r) {
            return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d || {} }; },
              function () { return { ok: r.ok, status: r.status, data: {} }; });
          });
        }
        function fill(s, p) {
          var out = String(s);
          for (var k in p) out = out.split("{" + k + "}").join(String(p[k]));
          return out;
        }
        function el(tag, attrs, text) {
          var n = document.createElement(tag);
          for (var k in (attrs || {})) n.setAttribute(k, attrs[k]);
          if (text !== undefined) n.textContent = text;
          return n;
        }
        function selected(sel) {
          for (var i = 0; i < sel.options.length; i++) if (sel.options[i].selected) return sel.options[i].value;
          return sel.options.length ? sel.options[0].value : "";
        }
        function field(labelText, control, hint) {
          var f = el("div", { "class": "mcat-dlg__field" });
          var l = el("label", {}, labelText);
          if (control.id) l.setAttribute("for", control.id);
          f.appendChild(l);
          f.appendChild(control);
          if (hint) f.appendChild(el("div", { "class": "mcat-dlg__hint" }, hint));
          return f;
        }
        function check(id, labelText, on) {
          var wrap = el("label", { "class": "mcat-dlg__check" });
          var box = el("input", { type: "checkbox", id: id });
          box.checked = !!on;
          wrap.appendChild(box);
          wrap.appendChild(el("span", {}, labelText));
          return wrap;
        }
        function textInput(id, value, attrs) {
          var i = el("input", Object.assign({ type: "text", id: id, autocomplete: "off", spellcheck: "false" }, attrs || {}));
          i.value = value || "";
          return i;
        }
        function overlay() { return document.getElementById("mcat-modal-overlay"); }
        function hide() { var o = overlay(); if (o) o.style.display = "none"; }

        function showError(box, data) {
          box.replaceChildren();
          box.appendChild(el("div", {}, (data.code ? data.code + ": " : "") + (data.error || T.failed)));
          if (Array.isArray(data.errors) && data.errors.length) {
            var ul = el("ul");
            data.errors.forEach(function (e) { ul.appendChild(el("li", {}, String(e))); });
            box.appendChild(ul);
          }
        }

        function render(opts, meta) {
          var mode = opts.mode;
          var row = opts.row || {};
          var isHf = mode === "hf-adopt";
          var isEdit = mode === "edit";
          var adopting = mode === "adopt" || isHf;
          var catalogId = isEdit ? row.catalogId : opts.catalogId;
          var box = el("div", { "class": "mcat-dlg" });
          var title = isEdit ? fill(T.titleEdit, { provider: row.provider })
            : isHf ? fill(T.titleHfAdopt, { file: opts.hfFile })
            : fill(mode === "adopt" ? T.titleAdopt : T.titleRegister, { model: catalogId });
          box.appendChild(el("div", { "class": "mcat-modal__title" }, title));

          var refs = {};
          if (!isHf) {
            // Provider id: defaults to the model id; suggested roles in a
            // datalist; locked when editing.
            refs.provider = textInput("mcat-dlg-provider", isEdit ? row.provider : catalogId, { list: "mcat-dlg-roles" });
            if (isEdit) refs.provider.disabled = true;
            var dl = el("datalist", { id: "mcat-dlg-roles" });
            (meta.roles || []).forEach(function (r) { dl.appendChild(el("option", { value: r })); });
            var pf = field(T.providerId, refs.provider, T.providerIdHint);
            pf.appendChild(dl);
            box.appendChild(pf);

            refs.quant = el("select", { id: "mcat-dlg-quant" });
            var quants = isEdit ? [row.quant] : (opts.quants && opts.quants.length ? opts.quants : [opts.quant]);
            var wantQuant = isEdit ? row.quant : (opts.quant || quants[0]);
            quants.forEach(function (q) {
              var o = el("option", { value: q }, q);
              if (q === wantQuant) o.selected = true;
              refs.quant.appendChild(o);
            });
            if (isEdit) refs.quant.disabled = true;
            box.appendChild(field(T.quant, refs.quant));

            refs.group = el("select", { id: "mcat-dlg-group" });
            var groups = (meta.groups || []).slice();
            if (isEdit && row.mutexGroup && groups.indexOf(row.mutexGroup) === -1) groups.push(row.mutexGroup);
            var wantGroup = isEdit ? (row.mutexGroup || "__none__") : "";
            [["", T.groupAuto], ["__none__", T.groupNone]].concat(groups.map(function (g) { return [g, g]; })).forEach(function (pair) {
              var o = el("option", { value: pair[0] }, pair[1]);
              if (pair[0] === wantGroup) o.selected = true;
              refs.group.appendChild(o);
            });
            box.appendChild(field(T.group, refs.group));

            box.appendChild(check("mcat-dlg-resident", T.resident, isEdit && row.alwaysResident));
            box.appendChild(check("mcat-dlg-default", T.defaultMember, isEdit && row.defaultMember));

            refs.launch = el("textarea", { id: "mcat-dlg-launch", spellcheck: "false", rows: "4" });
            var launch = isEdit ? row.launch : opts.launch;
            refs.launch.value = launch && typeof launch === "object" ? JSON.stringify(launch) : "";
            box.appendChild(field(T.launch, refs.launch, T.launchHint));
          }

          if (adopting) {
            refs.path = textInput("mcat-dlg-path", "", { placeholder: "/" });
            box.appendChild(field(T.path, refs.path));
            refs.companions = [];
            (isHf ? [] : (opts.companions || [])).forEach(function (kind) {
              var i = textInput("mcat-dlg-companion-" + kind, "", { "data-companion-kind": kind, placeholder: "/" });
              refs.companions.push(i);
              box.appendChild(field(fill(T.companion, { kind: kind }), i));
            });
            // hf-adopt always verifies the LFS sha256 (review 6): no size-only option.
            if (!isHf) box.appendChild(check("mcat-dlg-unverified", T.unverified, false));
            // Verified adopt hashes the whole file inside the request (review 3).
            box.appendChild(el("div", { "class": "mcat-dlg__hint" }, T.hashHint));
          }

          var err = el("div", { id: "mcat-dlg-error", "class": "mcat-dlg__error", role: "alert" });
          box.appendChild(err);

          var actions = el("div", { "class": "mcat-modal__actions" });
          var cancel = el("button", { type: "button", "class": "btn btn-secondary btn-sm" }, T.cancel);
          cancel.addEventListener("click", hide);
          var save = el("button", { type: "button", "class": "btn btn-primary btn-sm", id: "mcat-dlg-save" }, T.save);
          actions.appendChild(cancel);
          actions.appendChild(save);
          box.appendChild(actions);

          var pending = false;
          save.addEventListener("click", function () {
            // One request at a time: a verified adopt can hash for minutes.
            if (pending) return;
            var body;
            var path;
            if (isHf) {
              body = { hfRepo: opts.hfRepo, file: opts.hfFile, path: refs.path.value.trim() };
              path = "/hf-adopt";
            } else {
              var launchText = refs.launch.value.trim();
              var launchVal;
              if (launchText) {
                try { launchVal = JSON.parse(launchText); } catch (e) { err.replaceChildren(); err.appendChild(el("div", {}, T.badJson)); return; }
              }
              body = {
                catalogId: catalogId,
                quant: selected(refs.quant),
                providerId: isEdit ? row.provider : (refs.provider.value.trim() || catalogId),
                alwaysResident: !!document.getElementById("mcat-dlg-resident").checked,
                defaultMember: !!document.getElementById("mcat-dlg-default").checked
              };
              var g = selected(refs.group);
              if (g === "__none__") body.mutexGroup = null;
              else if (g) body.mutexGroup = g;
              if (launchVal !== undefined) body.launch = launchVal;
              if (mode === "adopt") {
                body.path = refs.path.value.trim();
                var cp = {};
                refs.companions.forEach(function (i) {
                  var v = i.value.trim();
                  if (v) cp[i.getAttribute("data-companion-kind")] = v;
                });
                body.companionPaths = cp;
                body.allowUnverified = !!document.getElementById("mcat-dlg-unverified").checked;
                path = "/adopt";
              } else {
                path = "/register";
              }
            }
            pending = true;
            save.disabled = true;
            save.textContent = T.saving;
            call("POST", path, body).then(function (res) {
              pending = false;
              save.disabled = false;
              save.textContent = T.save;
              if (!res.ok) { showError(err, res.data || {}); return; }
              // A running model keeps its old launch until restarted: leave a
              // note for the registered-models section after the reload.
              var pid = res.data && res.data.provider && res.data.provider.id;
              if (res.data && res.data.running && pid) {
                try {
                  var list = JSON.parse(sessionStorage.getItem("mcat-edited") || "[]");
                  if (list.indexOf(pid) === -1) list.push(pid);
                  sessionStorage.setItem("mcat-edited", JSON.stringify(list));
                } catch (e) { /* no note */ }
              }
              hide();
              location.reload();
            }).catch(function () {
              pending = false;
              save.disabled = false;
              save.textContent = T.save;
              showError(err, {});
            });
          });

          var mc = document.getElementById("mcat-modal-content");
          if (!mc) return;
          mc.replaceChildren();
          mc.appendChild(box);
          var o = overlay();
          if (o) o.style.display = "flex";
        }

        function open(opts) {
          if (!opts || !opts.mode) return;
          // Groups and suggested roles come from the registered listing.
          return call("GET", "/registered").then(function (res) {
            render(opts, res.ok ? res.data : {});
          }, function () { render(opts, {}); });
        }

        window.CrowModelDialog = { open: open };

        function parseList(s) {
          try { var v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; }
        }

        document.addEventListener("click", function (e) {
          var b = e.target && e.target.closest ? e.target.closest('[data-action="adopt"], [data-action="register-as"], [data-action="hf-adopt"]') : null;
          if (!b) return;
          var action = b.getAttribute("data-action");
          if (action === "hf-adopt") {
            open({ mode: "hf-adopt", hfRepo: b.getAttribute("data-hf-repo"), hfFile: b.getAttribute("data-hf-file") });
            return;
          }
          var card = b.closest(".mcat-card");
          if (!card) return;
          var launch = null;
          try { launch = JSON.parse(card.getAttribute("data-launch") || "null"); } catch (err) { launch = null; }
          open({
            mode: action === "adopt" ? "adopt" : "register",
            catalogId: card.getAttribute("data-model-id"),
            quant: card.getAttribute("data-registered-quant") || card.getAttribute("data-default-quant"),
            quants: parseList(card.getAttribute("data-quants")),
            companions: parseList(card.getAttribute("data-companions")),
            launch: launch
          });
        });
      })();
    </script>`;
}
