/**
 * Bot Builder — engine-attach gate client script (C4 Task 8).
 *
 * Two independent behaviors, one shared modal:
 *   1. Gateways-tab submit intercept (primary path): when the server
 *      rendered `#btb-gateways-form` with `data-engine-gate="1"` (engine
 *      absent for the CURRENT gwType, per isEngineAbsent() at render time),
 *      mirror Task 7's server-side completeness predicate client-side
 *      against the live DOM (data-engine-channels + data-engine-required-
 *      fields) and, on a complete record, preventDefault() the submit and
 *      open the install modal BEFORE the POST — so the operator's typed
 *      credentials never leave the DOM. On a successful install, the SAME
 *      still-populated form is resubmitted via requestSubmit() (never
 *      form.submit() — that would skip the fetch-wrapper's CSRF header
 *      attach path documented in shared/layout.js).
 *   2. Backstop banners: `error=engine_required` (a client that bypassed
 *      the intercept — JS disabled, or a race) renders a friendly banner
 *      with an "Install bot engine" button (#engine-gate-open-btn) that
 *      opens the identical modal; success just reloads (the server-side
 *      gate already discarded the typed values on that path, so there is
 *      nothing to resubmit). `warn=bot_runtime_off` renders a banner with a
 *      one-click enable button (#bot-runtime-enable-btn) that POSTs the
 *      settings action directly and reloads the clean (query-stripped) tab.
 *
 * The readiness checklist (Task 9, next) reuses this SAME modal via the
 * stable global hook window.__crowEngineGateOpen(onInstalled) — one
 * implementation, per spec open-Q3.
 *
 * ABSOLUTE RULE (matches extensions/client.js and onboarding/ai-step-
 * client.js, the established pattern for served browser JS in this
 * codebase): the returned <script> string is built inside a template
 * literal and must never contain a literal backtick character - not even
 * inside a comment. No literal backticks in the served string (quote style
 * and concatenation are unconstrained). ES5 style throughout (var, function
 * expressions, no arrow functions, no let/const, no template literals) -
 * this file ships unbundled straight to the browser.
 *
 * XSS: every dynamic string this script writes into the DOM goes through a
 * textContent assignment - never innerHTML with a concatenated string.
 */

import { tJs } from "../../shared/i18n.js";

export function engineGateClientJS(lang) {
  return `
    <div id="engine-gate-modal-overlay"><div id="engine-gate-modal-content"></div></div>
    <script>
      (function () {
        var API = "/dashboard/bundles/api";
        var BUNDLE_ID = "bot-engine";

        function overlayEl() { return document.getElementById("engine-gate-modal-overlay"); }
        function contentEl() { return document.getElementById("engine-gate-modal-content"); }
        function showEngineModal() { var o = overlayEl(); if (o) o.style.display = "flex"; }
        function hideEngineModal() { var o = overlayEl(); if (o) o.style.display = "none"; }

        var overlay = overlayEl();
        if (overlay) {
          overlay.addEventListener("click", function (e) { if (e.target === overlay) hideEngineModal(); });
        }

        function setEngineModalContent(el) {
          var mc = contentEl();
          if (!mc) return;
          mc.replaceChildren();
          mc.appendChild(el);
        }

        function pollEngineJob(jobId, statusEl, installBtn, onDone) {
          fetch(API + "/jobs/" + jobId).then(function (r) { return r.json(); }).then(function (job) {
            var log = (job && job.log) || [];
            statusEl.textContent = log[log.length - 1] || '${tJs("botbuilder.engineGateWorking", lang)}';
            if (job.status === "complete" || job.status === "complete_restart") {
              statusEl.style.color = "var(--crow-accent)";
              statusEl.textContent = '${tJs("botbuilder.engineGateDone", lang)}';
              onDone(true);
            } else if (job.status === "failed") {
              statusEl.style.color = "var(--crow-error, #e74c3c)";
              statusEl.textContent = '${tJs("botbuilder.engineGateInstallFailedPrefix", lang)}' + " " +
                (log[log.length - 1] || '${tJs("botbuilder.engineGateUnknownError", lang)}');
              installBtn.disabled = false;
              installBtn.textContent = '${tJs("botbuilder.engineGateRetryBtn", lang)}';
              onDone(false);
            } else {
              setTimeout(function () { pollEngineJob(jobId, statusEl, installBtn, onDone); }, 1000);
            }
          }).catch(function () {
            setTimeout(function () { pollEngineJob(jobId, statusEl, installBtn, onDone); }, 3000);
          });
        }

        function startEngineInstall(statusEl, installBtn, onDone) {
          installBtn.disabled = true;
          installBtn.textContent = '${tJs("botbuilder.engineGateInstallingBtn", lang)}';
          statusEl.style.display = "block";
          statusEl.style.color = "var(--crow-accent)";
          statusEl.textContent = '${tJs("botbuilder.engineGateWorking", lang)}';

          fetch(API + "/install", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bundle_id: BUNDLE_ID, env_vars: {} }),
          }).then(function (r) {
            return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
          }).then(function (res) {
            var jobId = res.data && res.data.job_id;
            if (jobId && (res.ok || (res.status === 409 && res.data.code === "already_installing"))) {
              pollEngineJob(jobId, statusEl, installBtn, onDone);
              return;
            }
            statusEl.style.color = "var(--crow-error, #e74c3c)";
            statusEl.textContent = '${tJs("botbuilder.engineGateInstallFailedPrefix", lang)}' + " " +
              ((res.data && res.data.error) || '${tJs("botbuilder.engineGateUnknownError", lang)}');
            installBtn.disabled = false;
            installBtn.textContent = '${tJs("botbuilder.engineGateRetryBtn", lang)}';
            onDone(false);
          }).catch(function () {
            statusEl.style.color = "var(--crow-error, #e74c3c)";
            statusEl.textContent = '${tJs("botbuilder.engineGateNetworkError", lang)}';
            installBtn.disabled = false;
            installBtn.textContent = '${tJs("botbuilder.engineGateRetryBtn", lang)}';
            onDone(false);
          });
        }

        // onInstalled runs once, ~0.9s after a successful install (long
        // enough for the "Installed..." status line to be readable before
        // the modal closes out from under it).
        function openEngineGateModal(onInstalled) {
          var frag = document.createElement("div");

          var h3 = document.createElement("h3");
          h3.style.cssText = "font-family:Fraunces,serif;margin-bottom:0.75rem";
          h3.textContent = '${tJs("botbuilder.engineGateModalTitle", lang)}';
          frag.appendChild(h3);

          var body = document.createElement("p");
          body.style.cssText = "color:var(--crow-text-secondary);font-size:0.9rem;margin-bottom:0.75rem";
          body.textContent = '${tJs("botbuilder.engineGateModalBody", lang)}';
          frag.appendChild(body);

          var diskNote = document.createElement("p");
          diskNote.style.cssText = "color:var(--crow-text-muted);font-size:0.8rem;margin-bottom:1rem";
          diskNote.textContent = '${tJs("botbuilder.engineGateModalDiskNote", lang)}';
          frag.appendChild(diskNote);

          var statusDiv = document.createElement("div");
          statusDiv.style.cssText = "font-size:0.85rem;margin:0.75rem 0;display:none";
          frag.appendChild(statusDiv);

          var btnRow = document.createElement("div");
          btnRow.style.cssText = "display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem";

          var cancelBtn = document.createElement("button");
          cancelBtn.type = "button";
          cancelBtn.className = "btn btn-secondary";
          cancelBtn.textContent = '${tJs("common.cancel", lang)}';
          cancelBtn.addEventListener("click", hideEngineModal);
          btnRow.appendChild(cancelBtn);

          var installBtn = document.createElement("button");
          installBtn.type = "button";
          installBtn.className = "btn btn-primary";
          installBtn.textContent = '${tJs("botbuilder.engineGateInstallBtn", lang)}';
          installBtn.addEventListener("click", function () {
            startEngineInstall(statusDiv, installBtn, function (success) {
              if (!success) return;
              setTimeout(function () {
                hideEngineModal();
                if (typeof onInstalled === "function") onInstalled();
              }, 900);
            });
          });
          btnRow.appendChild(installBtn);

          frag.appendChild(btnRow);
          setEngineModalContent(frag);
          showEngineModal();
        }

        // Stable hook for the readiness checklist row (Task 9) and any
        // other caller — reassigned on every script execution so it always
        // closes over THIS page's live overlay/content elements (a Turbo
        // Drive re-render swaps the whole panel body, including these
        // nodes, on every tab navigation; a one-shot guard here would leave
        // the hook pointing at detached DOM from a previous tab).
        window.__crowEngineGateOpen = function (onInstalled) {
          openEngineGateModal(onInstalled);
        };

        // --- 1. Gateways-tab submit intercept (primary path) ---
        var gwForm = document.getElementById("btb-gateways-form");
        if (gwForm && gwForm.getAttribute("data-engine-gate") === "1") {
          var channels = (gwForm.getAttribute("data-engine-channels") || "").split(",").filter(function (s) { return s; });
          var requiredFields = (gwForm.getAttribute("data-engine-required-fields") || "").split(",").filter(function (s) { return s; });
          var bypassGate = false;

          var fieldNonEmpty = function (name) {
            var els = gwForm.querySelectorAll("[name='" + name + "']");
            if (!els.length) return false;
            var v = els[0].value;
            return typeof v === "string" && v.trim().length > 0;
          };

          var recordIsComplete = function () {
            var typeEl = gwForm.querySelector("[name='gw_type']");
            var curType = typeEl ? typeEl.value : "";
            if (channels.indexOf(curType) === -1) return false;
            for (var i = 0; i < requiredFields.length; i++) {
              if (!fieldNonEmpty(requiredFields[i])) return false;
            }
            return true;
          };

          gwForm.addEventListener("submit", function (e) {
            if (bypassGate) { bypassGate = false; return; }
            if (!recordIsComplete()) return;
            e.preventDefault();
            openEngineGateModal(function () {
              bypassGate = true;
              if (gwForm.requestSubmit) gwForm.requestSubmit();
              else gwForm.submit();
            });
          });
        }

        // --- 2a. Backstop banner: error=engine_required ---
        var openBtn = document.getElementById("engine-gate-open-btn");
        if (openBtn) {
          openBtn.addEventListener("click", function () {
            openEngineGateModal(function () { location.reload(); });
          });
        }

        // --- 2b. Backstop banner: warn=bot_runtime_off (one-click enable) ---
        var runtimeBtn = document.getElementById("bot-runtime-enable-btn");
        if (runtimeBtn) {
          runtimeBtn.addEventListener("click", function () {
            var statusEl = document.getElementById("bot-runtime-enable-status");
            runtimeBtn.disabled = true;
            runtimeBtn.textContent = '${tJs("botbuilder.runtimeOffEnabling", lang)}';
            if (statusEl) statusEl.textContent = "";
            fetch("/dashboard/settings", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: "action=set_bot_runtime&enabled=on",
            }).then(function (r) {
              if (!r.ok) throw new Error("http " + r.status);
              if (statusEl) statusEl.textContent = '${tJs("botbuilder.runtimeOffEnabled", lang)}';
              setTimeout(function () {
                var url = new URL(location.href);
                url.searchParams.delete("warn");
                url.searchParams.delete("error");
                location.href = url.toString();
              }, 800);
            }).catch(function () {
              runtimeBtn.disabled = false;
              runtimeBtn.textContent = '${tJs("botbuilder.runtimeOffEnableBtn", lang)}';
              if (statusEl) statusEl.textContent = '${tJs("botbuilder.runtimeOffEnableFailed", lang)}';
            });
          });
        }
      })();
    </script>
  `;
}
