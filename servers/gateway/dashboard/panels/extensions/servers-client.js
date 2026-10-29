/**
 * Extensions › Servers, client side (SAT-5, spec §4.1, §4.2 step 2, §7.1, §8, §9.1).
 *
 *   - one card per paired server from GET /api/satellites: name, state, cert expiry, version vs
 *     crow (behind by N), memory / swap / PSI, disk, clock skew, installed extensions with their
 *     tool state; actions Update now, Refresh, Rename, Unpair, and per extension Approve tools,
 *     Restart, Logs, Remove;
 *   - "Add a server": the install command, host (typed, or picked from the tailnet peers), Start
 *     (pair/start), then the fingerprint and the whois answer side by side, the code, Confirm;
 *   - the server install dialog the host picker opens (client.js): env fields, the consent
 *     relay, the job, then the tool list to approve (the pin).
 *
 * All user data goes in through textContent. The script is a template literal: no backticks
 * anywhere inside it (CLAUDE.md lesson), ES5 only.
 */
import { tJs } from "../../shared/i18n.js";

export function serversClientJS(lang) {
  const T = (k) => tJs(`extensions.servers.${k}`, lang);
  return `
    <style>
      .ext-servers__head { display:flex; flex-wrap:wrap; gap:0.5rem 1rem; align-items:baseline; margin-bottom:1rem; }
      .ext-servers__head .ext-section-sub { flex:1 1 16rem; margin:0; }
      .ext-servers__list { display:grid; gap:1rem; }
      .sat-card { border:1px solid var(--crow-border); border-radius:10px; padding:1rem; background:var(--crow-bg-surface, transparent); }
      .sat-card__top { display:flex; flex-wrap:wrap; gap:0.5rem; align-items:center; }
      .sat-card__name { font-weight:600; font-size:1.05rem; }
      .sat-card__fp { font-family:'JetBrains Mono',monospace; font-size:0.75rem; color:var(--crow-text-muted); }
      .sat-card__grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(11rem,1fr)); gap:0.35rem 1rem; margin:0.75rem 0; font-size:0.85rem; }
      .sat-card__grid dt { color:var(--crow-text-muted); }
      .sat-card__grid dd { margin:0; }
      .sat-card__bundles { list-style:none; padding:0; margin:0.5rem 0; display:grid; gap:0.4rem; }
      .sat-card__bundle { display:flex; flex-wrap:wrap; gap:0.4rem; align-items:center; font-size:0.85rem; }
      .sat-card__actions { display:flex; flex-wrap:wrap; gap:0.4rem; }
      .sat-state { font-size:0.75rem; padding:0.1rem 0.45rem; border-radius:999px; border:1px solid var(--crow-border); }
      .sat-state--warn { border-color:var(--crow-warning, #b7791f); color:var(--crow-warning, #b7791f); }
      .sat-state--ok { border-color:var(--crow-success, #2f855a); color:var(--crow-success, #2f855a); }
      .sat-modal { position:fixed; inset:0; background:rgba(0,0,0,0.45); display:none; align-items:center; justify-content:center; z-index:1000; padding:16px; }
      .sat-modal__box { background:var(--crow-bg-deep, #fff); color:var(--crow-text-primary); border-radius:12px; max-width:40rem; width:100%; max-height:90vh; overflow:auto; padding:1.25rem; }
      .sat-modal__box h3 { margin-top:0; }
      .sat-modal__box pre { white-space:pre-wrap; word-break:break-all; font-size:0.78rem; background:var(--crow-bg-surface, rgba(0,0,0,0.05)); padding:0.6rem; border-radius:6px; max-height:50vh; overflow:auto; }
      .sat-modal__box label { display:block; margin:0.6rem 0 0.2rem; font-size:0.85rem; }
      .sat-modal__box input[type=text], .sat-modal__box input[type=password] { width:100%; box-sizing:border-box; padding:0.4rem 0.6rem; border:1px solid var(--crow-border); border-radius:4px; background:var(--crow-bg-deep); color:var(--crow-text-primary); }
      .sat-modal__row { display:flex; flex-wrap:wrap; gap:0.5rem; justify-content:flex-end; margin-top:1rem; }
      .sat-side { display:grid; grid-template-columns:repeat(auto-fit,minmax(14rem,1fr)); gap:0.75rem; margin:0.75rem 0; }
      .sat-side > div { border:1px solid var(--crow-border); border-radius:8px; padding:0.6rem; }
      .sat-side strong { display:block; font-size:0.78rem; color:var(--crow-text-muted); margin-bottom:0.25rem; }
      .sat-msg { font-size:0.85rem; margin-top:0.5rem; }
      .sat-msg--error { color:var(--crow-error, #c53030); }
      .sat-tools { list-style:none; padding:0; margin:0.5rem 0; font-size:0.85rem; }
      .sat-tools li { padding:0.3rem 0; border-bottom:1px solid var(--crow-border); }
      .sat-tools code { font-weight:600; }
      .ext-hostpick { display:inline-flex; gap:0.4rem; align-items:center; font-size:0.85rem; margin-right:auto; }
    </style>
    <div class="sat-modal" id="sat-modal" role="dialog" aria-modal="true"><div class="sat-modal__box" id="sat-modal-box"></div></div>
    <script>
      (function() {
        var BASE = "/api/satellites";
        var loaded = false;

        function el(tag, attrs, text) {
          var e = document.createElement(tag);
          if (attrs) for (var k in attrs) { if (k === "class") e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
          if (text !== undefined && text !== null) e.textContent = String(text);
          return e;
        }
        function btn(label, cls, onClick) {
          var b = el("button", { type: "button", "class": "btn btn-sm " + (cls || "btn-secondary") }, label);
          b.addEventListener("click", onClick);
          return b;
        }
        function api(method, path, body) {
          var init = { method: method, headers: { "Accept": "application/json" }, credentials: "same-origin" };
          if (body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
          return fetch(BASE + path, init).then(function(r) {
            return r.json().catch(function() { return {}; }).then(function(d) { return { ok: r.ok, status: r.status, data: d || {} }; });
          });
        }
        function errText(res) {
          var e = res && res.data && res.data.error;
          if (e === "update_first") return '${T("updateFirst")}';
          if (e === "unreachable") return '${T("unreachable")}';
          if (e === "installed_locally") return '${T("installedLocally")}';
          return e ? String(e) : '${T("failed")}';
        }

        // ── modal ───────────────────────────────────────────────────────────
        var modal = document.getElementById("sat-modal");
        var box = document.getElementById("sat-modal-box");
        function openModal(title) {
          while (box.firstChild) box.removeChild(box.firstChild);
          box.appendChild(el("h3", null, title));
          modal.style.display = "flex";
          return box;
        }
        function closeModal() { modal.style.display = "none"; }
        modal.addEventListener("click", function(e) { if (e.target === modal) closeModal(); });
        function msg(parent) { var m = el("p", { "class": "sat-msg", role: "status" }); parent.appendChild(m); return function(text, isErr) { m.textContent = text || ""; m.className = "sat-msg" + (isErr ? " sat-msg--error" : ""); }; }
        function row(parent) { var r = el("div", { "class": "sat-modal__row" }); parent.appendChild(r); return r; }

        // ── hosts for the picker (client.js reads this) ─────────────────────
        window.crowSatelliteHosts = function() {
          try { return JSON.parse((document.getElementById("satellite-hosts") || {}).textContent || "[]"); } catch (e) { return []; }
        };

        // ── cards ───────────────────────────────────────────────────────────
        var list = document.getElementById("ext-servers-list");
        function mb(b) { return b == null ? "?" : Math.round(b / 1048576) + " MB"; }
        function gb(b) { return b == null ? "?" : (b / 1e9).toFixed(1) + " GB"; }
        function addFact(dl, k, v) { dl.appendChild(el("dt", null, k)); dl.appendChild(el("dd", null, v)); }
        function toolsLabel(t) {
          var s = t && t.state;
          if (s === "ok") return '${T("toolsOk")}';
          if (s === "unpinned") return '${T("toolsUnpinned")}';
          if (s === "changed") return '${T("toolsChanged")}';
          if (s === "unavailable") return '${T("toolsUnavailable")}';
          if (s === "unreachable") return '${T("unreachable")}';
          return '${T("toolsUnknown")}';
        }

        function renderCard(s, crow) {
          var c = s.card || {};
          var card = el("article", { "class": "sat-card", "data-satellite": s.id });
          var top = el("div", { "class": "sat-card__top" });
          top.appendChild(el("span", { "class": "sat-card__name" }, s.name));
          var stateCls = s.status === "active" ? "sat-state sat-state--ok" : "sat-state sat-state--warn";
          top.appendChild(el("span", { "class": stateCls }, s.status === "active" ? '${T("stateActive")}' : '${T("stateUnreachable")}'));
          if (s.fingerprint) top.appendChild(el("span", { "class": "sat-card__fp" }, s.fingerprint));
          card.appendChild(top);

          var dl = el("dl", { "class": "sat-card__grid" });
          var days = c.cert_days_left;
          addFact(dl, '${T("cert")}', days == null ? "?" : (days < 0 ? '${T("certExpired")}' : days + ' ${T("days")}'));
          var ver = c.update_first ? '${T("updateFirst")}' : c.behind_by == null ? (c.sha ? c.sha.slice(0, 8) : "?") : c.behind_by === 0 ? '${T("upToDate")}' : '${T("behindBy")}'.replace("{n}", String(c.behind_by));
          addFact(dl, '${T("version")}', ver);
          var m = c.mem || {};
          addFact(dl, '${T("memory")}', mb(m.MemAvailable) + " / " + mb(m.MemTotal));
          addFact(dl, '${T("swap")}', mb(m.SwapFree) + " / " + mb(m.SwapTotal));
          addFact(dl, '${T("pressure")}', c.psi_memory_some_avg10 == null ? "?" : c.psi_memory_some_avg10 + " %");
          addFact(dl, '${T("disk")}', gb(c.disk_free_bytes));
          addFact(dl, '${T("skew")}', c.skew_ms == null ? "?" : (c.skew_ms / 1000).toFixed(1) + " s");
          addFact(dl, '${T("checked")}', c.polled_at ? new Date(c.polled_at).toLocaleString() : '${T("never")}');
          card.appendChild(dl);
          if (c.error) card.appendChild(el("p", { "class": "sat-msg sat-msg--error" }, c.error));

          var ul = el("ul", { "class": "sat-card__bundles" });
          (c.installed || []).forEach(function(b) {
            var li = el("li", { "class": "sat-card__bundle", "data-bundle": b.id });
            li.appendChild(el("strong", null, b.id));
            if (b.version) li.appendChild(el("span", null, "v" + b.version));
            li.appendChild(el("span", { "class": b.tools && b.tools.state === "ok" ? "sat-state sat-state--ok" : "sat-state sat-state--warn" }, toolsLabel(b.tools)));
            if (b.tools && (b.tools.state === "unpinned" || b.tools.state === "changed")) li.appendChild(btn('${T("approveTools")}', "btn-primary", function() { toolsDialog(s, b.id); }));
            li.appendChild(btn('${T("restart")}', null, function() { bundleAction(s, b.id, "restart"); }));
            li.appendChild(btn('${T("logs")}', null, function() { logsDialog(s, b.id); }));
            li.appendChild(btn('${T("remove")}', null, function() {
              if (!confirm('${T("removeConfirm")}'.replace("{bundle}", b.id).replace("{name}", s.name))) return;
              api("POST", "/" + s.id + "/bundles/" + b.id + "/uninstall", {}).then(function(res) {
                if (res.status === 202) return watchJob(s, res.data.job_id, null).then(load);
                alert(errText(res));
              });
            }));
            ul.appendChild(li);
          });
          if (!(c.installed || []).length) ul.appendChild(el("li", { "class": "sat-card__bundle" }, '${T("noExtensions")}'));
          card.appendChild(ul);

          var act = el("div", { "class": "sat-card__actions" });
          var say = el("span", { "class": "sat-msg", role: "status" });
          act.appendChild(btn('${T("updateNow")}', "btn-primary", function() {
            say.textContent = '${T("updating")}';
            api("POST", "/" + s.id + "/update", {}).then(function(res) { say.textContent = res.ok ? '${T("updateStarted")}' : errText(res); });
          }));
          act.appendChild(btn('${T("refresh")}', null, function() { api("POST", "/" + s.id + "/refresh", {}).then(load); }));
          act.appendChild(btn('${T("rename")}', null, function() {
            var n = prompt('${T("renamePrompt")}', s.name);
            if (n === null) return;
            api("POST", "/" + s.id + "/rename", { name: n }).then(function(res) { if (!res.ok) alert(errText(res)); load(); });
          }));
          act.appendChild(btn('${T("unpair")}', null, function() {
            if (!confirm('${T("unpairConfirm")}'.replace("{name}", s.name))) return;
            api("POST", "/" + s.id + "/unpair", { reason: "owner" }).then(function(res) { if (!res.ok) alert(errText(res)); location.reload(); });
          }));
          act.appendChild(say);
          card.appendChild(act);
          return card;
        }

        function load() {
          return api("GET", "").then(function(res) {
            while (list.firstChild) list.removeChild(list.firstChild);
            var sats = ((res.data && res.data.satellites) || []).filter(function(s) { return s.status !== "revoked"; });
            if (!res.ok) { list.appendChild(el("p", { "class": "sat-msg sat-msg--error" }, errText(res))); return; }
            if (!sats.length) { list.appendChild(el("p", { "class": "ext-section-sub" }, '${T("none")}')); return; }
            sats.forEach(function(s) { list.appendChild(renderCard(s, res.data.crow || {})); });
          });
        }
        window.crowServersShown = function() { if (!loaded) { loaded = true; load(); } };

        function bundleAction(s, bundle, action) {
          api("POST", "/" + s.id + "/bundles/" + bundle + "/" + action, {}).then(function(res) { alert(res.ok ? '${T("done")}' : errText(res)); });
        }

        function watchJob(s, jobId, say) {
          return new Promise(function(resolve) {
            (function poll() {
              api("GET", "/" + s.id + "/jobs/" + jobId).then(function(res) {
                var j = res.data || {};
                if (say && j.log && j.log.length) say(j.log[j.log.length - 1]);
                if (res.ok && j.status === "running") return setTimeout(poll, 1500);
                resolve(j);
              }).catch(function() { setTimeout(poll, 3000); });
            })();
          });
        }

        function logsDialog(s, bundle) {
          var b = openModal('${T("logsTitle")}'.replace("{bundle}", bundle).replace("{name}", s.name));
          var pre = el("pre", null, '${T("loading")}');
          b.appendChild(pre);
          row(b).appendChild(btn('${T("close")}', null, closeModal));
          api("GET", "/" + s.id + "/bundles/" + bundle + "/logs?tail=200").then(function(res) {
            pre.textContent = res.ok ? (res.data.log || "") + (res.data.truncated ? "\\n…" : "") : errText(res);
          });
        }

        // ── tools + pin approval (spec §9.1) ────────────────────────────────
        function toolsDialog(s, bundle, after) {
          var b = openModal('${T("toolsTitle")}'.replace("{bundle}", bundle).replace("{name}", s.name));
          var say = msg(b);
          say('${T("loading")}');
          api("GET", "/" + s.id + "/bundles/" + bundle + "/tools").then(function(res) {
            if (!res.ok) { say(errText(res), true); row(b).appendChild(btn('${T("close")}', null, closeModal)); return; }
            var d = res.data;
            say(d.pin ? '${T("toolsReapprove")}' : '${T("toolsFirst")}');
            if (d.diff) b.appendChild(el("p", { "class": "sat-msg" }, ["+ " + d.diff.added.join(", "), "− " + d.diff.removed.join(", "), "~ " + d.diff.changed.join(", ")].join("   ")));
            if (d.same_version && d.diff) b.appendChild(el("p", { "class": "sat-msg sat-msg--error" }, '${T("suspicious")}'));
            var ul = el("ul", { "class": "sat-tools" });
            var bad = {};
            (d.check.problems || []).forEach(function(p) { bad[p.name] = p.problem; });
            d.tools.forEach(function(t) {
              var li = el("li");
              li.appendChild(el("code", null, t.name));
              li.appendChild(document.createTextNode(" " + (t.description || "")));
              if (bad[t.name]) li.appendChild(el("em", null, " (" + '${T("toolDropped")}' + ")"));
              ul.appendChild(li);
            });
            b.appendChild(ul);
            b.appendChild(el("p", { "class": "sat-msg" }, '${T("toolsWrite")}'));
            var r = row(b);
            r.appendChild(btn('${T("cancel")}', null, closeModal));
            var ok = btn('${T("approve")}', "btn-primary", function() {
              ok.disabled = true;
              api("POST", "/" + s.id + "/bundles/" + bundle + "/approve-tools", { tools_sha256: d.tools_sha256 }).then(function(res2) {
                if (!res2.ok) { ok.disabled = false; say(errText(res2), true); return; }
                closeModal();
                if (after) after(); else load();
              });
            });
            if (d.check.tooMany) { ok.disabled = true; say('${T("tooMany")}', true); }
            r.appendChild(ok);
          });
        }

        // ── install on a server (the host picker in client.js calls this) ────
        window.crowSatelliteInstall = function(addon, satId) {
          var host = window.crowSatelliteHosts().filter(function(h) { return h.id === satId; })[0] || { id: satId, name: satId };
          var s = { id: host.id, name: host.name };
          var b = openModal('${T("installTitle")}'.replace("{bundle}", addon.name || addon.id).replace("{name}", s.name));
          var inputs = {};
          (addon.env_vars || []).forEach(function(v) {
            if (!v || !v.name) return;
            b.appendChild(el("label", { "for": "sat-env-" + v.name }, v.name + (v.description ? " — " + v.description : "")));
            var i = el("input", { id: "sat-env-" + v.name, type: v.secret ? "password" : "text", autocomplete: "off" });
            if (v.default && !v.secret) i.value = v.default;
            b.appendChild(i);
            inputs[v.name] = i;
          });
          var say = msg(b);
          var r = row(b);
          r.appendChild(btn('${T("cancel")}', null, closeModal));
          var go = btn('${T("install")}', "btn-primary", function() { start(null); });
          r.appendChild(go);
          function envBody() {
            var env = {};
            for (var k in inputs) if (inputs[k].value) env[k] = inputs[k].value;
            return env;
          }
          function start(consentToken) {
            go.disabled = true;
            say('${T("installing")}');
            var body = { bundle: addon.id, env: envBody() };
            if (consentToken) body.consent_token = consentToken;
            api("POST", "/" + s.id + "/bundles/install", body).then(function(res) {
              if (res.status === 403 && res.data.error === "consent_required" && res.data.challenge) return askConsent(res.data.challenge);
              if (res.status !== 202) { go.disabled = false; say(errText(res), true); return; }
              watchJob(s, res.data.job_id, say).then(function(j) {
                if (j.status !== "complete") { go.disabled = false; say('${T("installFailed")}' + (j.log && j.log.length ? ": " + j.log[j.log.length - 1] : ""), true); return; }
                toolsDialog(s, addon.id, function() { location.reload(); });
              });
            });
          }
          function askConsent(ch) {
            say("");
            var c = el("div", { "class": "sat-side" });
            var inner = el("div");
            inner.appendChild(el("strong", null, '${T("consentTitle")}'));
            inner.appendChild(el("p", null, ch.message || ""));
            c.appendChild(inner);
            b.insertBefore(c, r);
            go.textContent = '${T("consentAccept")}';
            go.disabled = false;
            go.onclick = null;
            var fresh = go.cloneNode(true);
            r.replaceChild(fresh, go);
            go = fresh;
            go.addEventListener("click", function() {
              go.disabled = true;
              api("POST", "/" + s.id + "/bundles/" + addon.id + "/consent", { token: ch.token, accept: true }).then(function(res) {
                if (!res.ok || !res.data.consent_token) { go.disabled = false; say(errText(res), true); return; }
                c.parentNode.removeChild(c);
                start(res.data.consent_token);
              });
            });
          }
        };

        // ── Add a server (spec §4.1, §4.2) ──────────────────────────────────
        var addBtn = document.getElementById("ext-servers-add");
        if (addBtn) addBtn.addEventListener("click", function() {
          var b = openModal('${T("addTitle")}');
          b.appendChild(el("p", null, '${T("addStep1")}'));
          var cmd = el("pre", { "data-testid": "install-command" }, '${T("loading")}');
          b.appendChild(cmd);
          api("GET", "/install-command").then(function(res) { cmd.textContent = res.ok ? res.data.command : '${T("noCommand")}'; });
          b.appendChild(el("label", { "for": "sat-host" }, '${T("hostLabel")}'));
          var hostIn = el("input", { id: "sat-host", type: "text", list: "sat-peers", autocomplete: "off", placeholder: "server.example.ts.net" });
          b.appendChild(hostIn);
          var dlist = el("datalist", { id: "sat-peers" });
          b.appendChild(dlist);
          api("GET", "/peers").then(function(res) {
            ((res.data && res.data.peers) || []).forEach(function(p) {
              var o = el("option", { value: p.name });
              o.textContent = p.name + (p.tags && p.tags.length ? " (" + p.tags.join(", ") + ")" : "") + (p.online ? "" : " — offline");
              dlist.appendChild(o);
            });
          });
          var say = msg(b);
          var r = row(b);
          r.appendChild(btn('${T("cancel")}', null, closeModal));
          var startBtn = btn('${T("connect")}', "btn-primary", function() {
            startBtn.disabled = true;
            say('${T("connecting")}');
            api("POST", "/pair/start", { host: hostIn.value }).then(function(res) {
              if (!res.ok) { startBtn.disabled = false; say(errText(res), true); return; }
              confirmStep(res.data);
            });
          });
          r.appendChild(startBtn);

          function confirmStep(p) {
            var b2 = openModal('${T("confirmTitle")}');
            b2.appendChild(el("p", null, '${T("confirmHelp")}'));
            var side = el("div", { "class": "sat-side" });
            var fp = el("div");
            fp.appendChild(el("strong", null, '${T("fingerprint")}'));
            fp.appendChild(el("code", { "data-testid": "fingerprint" }, p.fingerprint));
            side.appendChild(fp);
            var who = el("div");
            who.appendChild(el("strong", null, '${T("whois")}'));
            var w = p.whois || {};
            who.appendChild(el("div", { "data-testid": "whois" }, w.unknown ? '${T("whoisUnknown")}' : (w.node || "?") + (w.tags ? " · " + w.tags.join(", ") : w.login ? " · " + w.login : "")));
            side.appendChild(who);
            b2.appendChild(side);
            var noWhois = null;
            if (p.warning === "whois_unavailable") {
              var lab = el("label");
              noWhois = el("input", { type: "checkbox" });
              lab.appendChild(noWhois);
              lab.appendChild(document.createTextNode(" " + '${T("confirmWithoutWhois")}'));
              b2.appendChild(lab);
            }
            b2.appendChild(el("label", { "for": "sat-code" }, '${T("codeLabel")}'));
            var codeIn = el("input", { id: "sat-code", type: "text", autocomplete: "off", spellcheck: "false", placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" });
            b2.appendChild(codeIn);
            b2.appendChild(el("label", { "for": "sat-name" }, '${T("nameLabel")}'));
            var nameIn = el("input", { id: "sat-name", type: "text", autocomplete: "off" });
            b2.appendChild(nameIn);
            var say2 = msg(b2);
            var r2 = row(b2);
            r2.appendChild(btn('${T("cancel")}', null, closeModal));
            var ok = btn('${T("confirm")}', "btn-primary", function() {
              ok.disabled = true;
              api("POST", "/pair/complete", { pairing_id: p.pairing_id, code: codeIn.value, name: nameIn.value, confirm_without_whois: !!(noWhois && noWhois.checked) }).then(function(res) {
                if (!res.ok) { ok.disabled = false; say2(errText(res), true); return; }
                say2('${T("connected")}'.replace("{name}", res.data.name));
                setTimeout(function() { location.hash = "servers"; location.reload(); }, 900);
              });
            });
            r2.appendChild(ok);
          }
        });

        document.querySelectorAll("[data-view-link=servers]").forEach(function(a) {
          a.addEventListener("click", function(e) {
            var tab = document.querySelector(".ext-viewtab[data-view=servers]");
            if (tab) { e.preventDefault(); tab.click(); }
          });
        });
      })();
    </script>`;
}
