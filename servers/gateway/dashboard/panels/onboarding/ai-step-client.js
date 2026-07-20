/**
 * Onboarding AI step - client-side JavaScript (C1/C3 Task 7).
 *
 * The first client script the onboarding wizard ever ships (every other
 * step is 100% server-rendered, refresh/back-safe with a plain query-param
 * nav). Scope is deliberately narrow: populate the "run locally" card from
 * one GET /api/models/catalog fetch, drive the in-wizard download + its
 * progress UI, swap the cloud-provider preset's default model, and toggle
 * which of the three option panels is visible.
 *
 * ABSOLUTE RULE (matches extensions/client.js and model-catalog.js, the
 * established pattern for served browser JS in this codebase): the
 * returned <script> string is built inside a template literal and must
 * never contain a literal backtick character - not even inside a comment.
 * No literal backticks in the served string (quote style and concatenation
 * are unconstrained). ES5 style throughout (var, function expressions, no arrow
 * functions, no let/const, no template literals) - this file ships
 * unbundled straight to the browser.
 *
 * Card facts come from exactly ONE client fetch of GET /api/models/catalog
 * (it self-warms a cold probe cache server-side and returns per-quant
 * fitBadge already computed - routes/models.js:210-263). This file never
 * calls POST /api/models/reprobe and never recomputes a fit badge itself.
 *
 * XSS: every catalog-derived string this script writes into the DOM goes
 * through a textContent assignment - never innerHTML with a concatenated
 * string.
 */

import { tJs } from "../../shared/i18n.js";

export function aiStepClientJS(lang) {
  return `
    <script>
      (function () {
        function byId(id) { return document.getElementById(id); }

        // --- Option radios <-> panel visibility ---
        var PANELS = { local: byId("onb-ai-panel-local"), cloud: byId("onb-ai-panel-cloud"), skip: byId("onb-ai-panel-skip") };
        var RADIOS = document.querySelectorAll('input[name="onbAiChoice"]');
        function showPanel(which) {
          for (var key in PANELS) {
            if (!Object.prototype.hasOwnProperty.call(PANELS, key)) continue;
            var el = PANELS[key];
            if (el) el.hidden = (key !== which);
          }
        }
        for (var ri = 0; ri < RADIOS.length; ri++) {
          RADIOS[ri].addEventListener("change", function (e) {
            if (e.target.checked) showPanel(e.target.value);
          });
        }

        // --- Cloud preset -> default model + key placeholder ---
        var presetSelect = byId("onb-ai-cloud-preset");
        var modelInput = byId("onb-ai-cloud-model");
        var keyInput = byId("onb-ai-cloud-key");
        if (presetSelect) {
          presetSelect.addEventListener("change", function () {
            var opt = presetSelect.options[presetSelect.selectedIndex];
            if (!opt) return;
            if (modelInput) modelInput.value = opt.getAttribute("data-default-model") || "";
            if (keyInput) keyInput.setAttribute("placeholder", opt.getAttribute("data-key-hint") || "");
          });
        }

        // --- helpers shared with model-catalog.js's client script ---
        function fmtBytes(n) {
          if (n === null || n === undefined || isNaN(n)) return "?";
          if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
          if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
          if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
          return n + " B";
        }
        function sizeGbText(mb) {
          if (typeof mb !== "number" || isNaN(mb)) return "?";
          return '${tJs("onboarding.ai.sizeGb", lang)}'.split("{gb}").join((mb / 1024).toFixed(1));
        }
        function fmtEta(seconds) {
          if (seconds === null || seconds === undefined || !isFinite(seconds) || seconds < 0) return "--";
          var totalMin = Math.round(seconds / 60);
          if (totalMin < 1) return "< 1 min";
          if (totalMin < 60) return totalMin + " min";
          var h = Math.floor(totalMin / 60);
          var m = totalMin % 60;
          return h + "h " + m + "m";
        }

        var ERROR_MESSAGES = {
          NETWORK_DENIED: '${tJs("models.errNetworkDenied", lang)}',
          UNAUTHENTICATED: '${tJs("models.errUnauthenticated", lang)}',
          UNKNOWN_MODEL: '${tJs("models.errUnknownModel", lang)}',
          UNKNOWN_QUANT: '${tJs("models.errUnknownQuant", lang)}',
          WONT_FIT: '${tJs("models.errWontFit", lang)}',
          INTERNAL: '${tJs("models.errInternal", lang)}'
        };
        function messageFor(code, fallback) {
          return ERROR_MESSAGES[code] || fallback || '${tJs("models.errInternal", lang)}';
        }

        // --- Local card state ---
        var nameEl = byId("onb-ai-local-name");
        var sizeEl = byId("onb-ai-local-size");
        var fitEl = byId("onb-ai-local-fit");
        var upsellEl = byId("onb-ai-local-upsell");
        var actionEl = byId("onb-ai-local-action");

        var defaultModelId = null;
        var defaultQuantId = null;
        var believeActive = false;   // we think a job is downloading/registering
        var reattempted = false;     // re-POST-once guard for a vanished job
        var samples = [];            // rolling {t, bytesDone} window, capped at 5

        function highlightNext() {
          var nextBtn = byId("onboarding-next-btn");
          if (nextBtn) {
            nextBtn.style.outline = "2px solid var(--crow-accent, #6c8fff)";
            nextBtn.style.outlineOffset = "2px";
          }
        }

        function renderDownloadButton() {
          if (!actionEl) return;
          actionEl.replaceChildren();
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "btn btn-primary btn-sm";
          btn.id = "onb-ai-download-btn";
          btn.textContent = '${tJs("onboarding.ai.downloadStart", lang)}';
          btn.addEventListener("click", startDownload);
          actionEl.appendChild(btn);
        }

        function renderRetryButton(message) {
          if (!actionEl) return;
          actionEl.replaceChildren();
          var msg = document.createElement("div");
          msg.className = "onb-ai-status";
          msg.textContent = message;
          actionEl.appendChild(msg);
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "btn btn-secondary btn-sm";
          btn.textContent = '${tJs("onboarding.ai.downloadRetry", lang)}';
          btn.addEventListener("click", startDownload);
          actionEl.appendChild(btn);
        }

        function renderProgress(status, bytesDone, totalBytes) {
          if (!actionEl) return;
          var wrap = byId("onb-ai-progress-wrap");
          if (!wrap) {
            actionEl.replaceChildren();
            wrap = document.createElement("div");
            wrap.id = "onb-ai-progress-wrap";
            var track = document.createElement("div");
            track.className = "onb-ai-progress-track";
            var bar = document.createElement("div");
            bar.className = "onb-ai-progress-bar";
            bar.id = "onb-ai-progress-bar";
            track.appendChild(bar);
            wrap.appendChild(track);
            var status_ = document.createElement("div");
            status_.className = "onb-ai-status";
            status_.id = "onb-ai-progress-status";
            wrap.appendChild(status_);
            actionEl.appendChild(wrap);
          }
          var bar2 = byId("onb-ai-progress-bar");
          var pct = totalBytes ? Math.round((bytesDone / totalBytes) * 100) : 0;
          if (bar2) bar2.style.width = pct + "%";

          var now = Date.now();
          samples.push({ t: now, bytesDone: bytesDone || 0 });
          if (samples.length > 5) samples.shift();

          var rateText = "--";
          var etaText = "--";
          if (samples.length >= 2) {
            var first = samples[0];
            var last = samples[samples.length - 1];
            var dtSec = (last.t - first.t) / 1000;
            var dBytes = last.bytesDone - first.bytesDone;
            if (dtSec > 0 && dBytes >= 0) {
              var rate = dBytes / dtSec;
              rateText = fmtBytes(rate) + "/s";
              if (rate > 0 && totalBytes) {
                etaText = fmtEta((totalBytes - bytesDone) / rate);
              }
            }
          }

          var statusEl2 = byId("onb-ai-progress-status");
          if (statusEl2) {
            var label = status === "registering" ? '${tJs("models.actionRegistering", lang)}' : '${tJs("models.actionDownloading", lang)}';
            var etaLabel = '${tJs("onboarding.ai.downloadEta", lang)}'.split("{eta}").join(etaText);
            statusEl2.textContent = label + " " + fmtBytes(bytesDone) + (totalBytes ? " / " + fmtBytes(totalBytes) : "") + " (" + rateText + ") - " + etaLabel;
          }
        }

        function renderDone() {
          if (!actionEl) return;
          actionEl.replaceChildren();
          var done = document.createElement("div");
          done.className = "onb-ai-status onb-ai-status--done";
          done.textContent = '${tJs("onboarding.ai.downloadDone", lang)}';
          actionEl.appendChild(done);
          highlightNext();
        }

        function renderAlreadyInstalled() {
          if (!actionEl) return;
          actionEl.replaceChildren();
          var done = document.createElement("div");
          done.className = "onb-ai-status onb-ai-status--done";
          done.textContent = '${tJs("onboarding.ai.localAlreadyInstalled", lang)}';
          actionEl.appendChild(done);
          highlightNext();
        }

        function pollDownload(jobId) {
          fetch("/api/models/downloads").then(function (r) { return r.json(); }).then(function (data) {
            var jobs = (data && data.downloads) || [];
            var job = null;
            for (var i = 0; i < jobs.length; i++) { if (jobs[i].id === jobId) { job = jobs[i]; break; } }

            if (!job) {
              // The gateway restarted and the in-memory job vanished
              // (routes/models.js:206) - re-POST once to resume from the
              // on-disk journal, never loop forever re-posting.
              if (believeActive && !reattempted) {
                reattempted = true;
                fetch("/api/models/download", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ modelId: defaultModelId, quant: defaultQuantId })
                }).catch(function () {});
              }
              setTimeout(function () { pollDownload(jobId); }, 1500);
              return;
            }

            if (job.status === "downloading" || job.status === "registering") {
              renderProgress(job.status, job.bytesDone, job.totalBytes);
              setTimeout(function () { pollDownload(jobId); }, 1500);
            } else if (job.status === "done") {
              believeActive = false;
              renderDone();
            } else if (job.status === "error") {
              believeActive = false;
              var msg = messageFor(job.errorCode, job.error);
              renderRetryButton(msg);
            } else {
              setTimeout(function () { pollDownload(jobId); }, 1500);
            }
          }).catch(function () {
            setTimeout(function () { pollDownload(jobId); }, 3000);
          });
        }

        function startDownload() {
          if (!defaultModelId || !defaultQuantId) return;
          if (actionEl) {
            actionEl.replaceChildren();
            var status = document.createElement("div");
            status.className = "onb-ai-status";
            status.textContent = '${tJs("models.actionDownloading", lang)}';
            actionEl.appendChild(status);
          }
          samples = [];
          believeActive = true;
          reattempted = false;
          var jobId = defaultModelId + "::" + defaultQuantId;
          fetch("/api/models/download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ modelId: defaultModelId, quant: defaultQuantId })
          }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
            .then(function (res) {
              if (res.ok || res.status === 202) {
                pollDownload(jobId);
              } else {
                believeActive = false;
                var msg = res.data && res.data.code === "WONT_FIT"
                  ? messageFor("WONT_FIT", res.data.error)
                  : messageFor(res.data && res.data.code, res.data && res.data.error);
                renderRetryButton(msg);
              }
            }).catch(function () {
              believeActive = false;
              renderRetryButton(messageFor("INTERNAL"));
            });
        }

        function findDefaultModel(catalog) {
          var models = (catalog && catalog.models) || [];
          for (var i = 0; i < models.length; i++) { if (models[i].first_run_default) return models[i]; }
          return models[0] || null;
        }
        function findQuant(model, quantId) {
          var quants = (model && model.quants) || [];
          for (var i = 0; i < quants.length; i++) { if (quants[i].quant === quantId) return quants[i]; }
          return null;
        }

        function computeUpsell(catalog, model, quantEntry) {
          if (!catalog || !catalog.probe || catalog.probe.accel === "cpu") return false;
          var baseSize = quantEntry ? quantEntry.size_mb : 0;
          var models = catalog.models || [];
          for (var i = 0; i < models.length; i++) {
            var m = models[i];
            if (!m || m.id === model.id) continue;
            var q = findQuant(m, m.default_quant);
            if (!q) continue;
            if (q.size_mb > baseSize && (q.fitBadge === "fits" || q.fitBadge === "tight")) return true;
          }
          return false;
        }

        function renderLocalCard(catalog, activeJob) {
          var model = findDefaultModel(catalog);
          if (!model) {
            if (nameEl) nameEl.textContent = '${tJs("models.emptyCatalog", lang)}';
            return;
          }
          defaultModelId = model.id;
          defaultQuantId = model.default_quant;
          var quantEntry = findQuant(model, model.default_quant);

          if (nameEl) nameEl.textContent = model.id;
          if (sizeEl) sizeEl.textContent = quantEntry ? sizeGbText(quantEntry.size_mb) : "";

          var fit = quantEntry ? quantEntry.fitBadge : "unknown";
          if (fitEl) {
            if (fit === "fits" || fit === "tight") {
              fitEl.textContent = '${tJs("onboarding.ai.localFits", lang)}';
            } else if (fit === "wont_fit") {
              fitEl.textContent = '${tJs("onboarding.ai.localWontFit", lang)}';
            } else {
              fitEl.textContent = '${tJs("onboarding.ai.localUnknown", lang)}';
            }
          }

          if (upsellEl) {
            if (computeUpsell(catalog, model, quantEntry)) {
              upsellEl.hidden = false;
              upsellEl.replaceChildren();
              upsellEl.appendChild(document.createTextNode('${tJs("onboarding.ai.upsell", lang)} '));
              var upsellLink = document.createElement("a");
              upsellLink.href = "/dashboard/model-catalog";
              upsellLink.textContent = '${tJs("onboarding.ai.upsellLink", lang)}';
              upsellEl.appendChild(upsellLink);
            } else {
              upsellEl.hidden = true;
            }
          }

          // fitBadge !== "wont_fit" keeps "local" pre-selected (server
          // default); a definitive "won't fit" hands the pre-selection to
          // the cloud option instead - unless the page already carries
          // ?cloud=ok (a just-completed cloud setup keeps its own state).
          var cloudRadio = byId("onb-ai-radio-cloud");
          var localRadio = byId("onb-ai-radio-local");
          var alreadyCloudOk = cloudRadio && cloudRadio.checked;
          if (fit === "wont_fit" && !alreadyCloudOk && cloudRadio && localRadio) {
            localRadio.checked = false;
            cloudRadio.checked = true;
            showPanel("cloud");
          }

          if (model.registered) {
            believeActive = false;
            renderAlreadyInstalled();
            return;
          }

          var jobId = model.id + "::" + model.default_quant;
          var job = null;
          if (activeJob) {
            var jobs = activeJob.downloads || [];
            for (var i = 0; i < jobs.length; i++) { if (jobs[i].id === jobId) { job = jobs[i]; break; } }
          }
          if (job && (job.status === "downloading" || job.status === "registering")) {
            believeActive = true;
            renderProgress(job.status, job.bytesDone, job.totalBytes);
            pollDownload(jobId);
          } else {
            renderDownloadButton();
          }
        }

        // --- Init: one catalog fetch (self-warms probe) + one downloads
        // fetch (reattach-on-return), before the idle card ever renders. ---
        Promise.all([
          fetch("/api/models/catalog").then(function (r) { return r.json(); }),
          fetch("/api/models/downloads").then(function (r) { return r.json(); })
        ]).then(function (results) {
          renderLocalCard(results[0], results[1]);
        }).catch(function () {
          if (nameEl) nameEl.textContent = '${tJs("models.errInternal", lang)}';
        });
      })();
    </script>
  `;
}
