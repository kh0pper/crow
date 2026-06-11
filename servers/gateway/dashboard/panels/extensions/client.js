/**
 * Extensions Panel — Client-side JavaScript
 *
 * Modal overlay divs, install/uninstall/detail modals, category filter tabs,
 * search, bundle start/stop, and job polling.
 *
 * Returns the full HTML+JS block including the #modal-overlay and #modal-content
 * divs that precede the <script> tag.
 */

import { tJs } from "../../shared/i18n.js";

export function extensionsClientJS(lang) {
  return `
    <div id="modal-overlay">
      <div id="modal-content"></div>
    </div>

    <script>
      (function() {
        var API = "/dashboard/bundles/api";

        // --- Modal helpers ---
        function showModal() { document.getElementById("modal-overlay").style.display = "flex"; }
        function hideModal() { document.getElementById("modal-overlay").style.display = "none"; }
        document.getElementById("modal-overlay").addEventListener("click", function(e) {
          if (e.target === this) hideModal();
        });

        function setModalContent(el) {
          var mc = document.getElementById("modal-content");
          mc.replaceChildren();
          mc.appendChild(el);
        }

        function showStatus(id, msg, type) {
          var el = document.getElementById("status-" + id);
          if (el) {
            el.style.display = "block";
            el.style.color = type === "error" ? "var(--crow-error, #e74c3c)" : "var(--crow-accent)";
            el.textContent = msg;
          }
        }

        function apiCall(endpoint, body) {
          return fetch(API + "/" + endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); });
        }

        // --- Bundle start/stop ---
        document.querySelectorAll(".bundle-action").forEach(function(btn) {
          btn.addEventListener("click", function() {
            var action = this.dataset.action;
            var id = this.dataset.id;
            showStatus(id, action === "start" ? '${tJs("extensions.starting", lang)}' : '${tJs("extensions.stopping", lang)}', "info");
            apiCall(action, { bundle_id: id }).then(function(res) {
              if (res.ok) {
                showStatus(id, res.data.message || '${tJs("extensions.done", lang)}', "info");
                setTimeout(function() { location.reload(); }, 1500);
              } else {
                showStatus(id, res.data.error || '${tJs("extensions.failed", lang)}', "error");
              }
            }).catch(function(err) {
              showStatus(id, '${tJs("extensions.networkError", lang)}', "error");
            });
          });
        });

        // --- Install modal (extracted as named function) ---
        function showInstallModal(id, name, envVars, minRam, minDisk, isCommunity) {
            var frag = document.createElement("div");

            var h3 = document.createElement("h3");
            h3.style.cssText = "font-family:Fraunces,serif;margin-bottom:0.75rem";
            h3.textContent = '${tJs("extensions.installTitle", lang)}' + " " + name;
            frag.appendChild(h3);

            // PR 0: Consent gate. Before showing env config, check whether the bundle
            // requires server-validated consent (privileged or consent_required).
            // If yes, render a warning box with capability list and gate the install
            // button until the user checks "I understand" (and types INSTALL for privileged).
            // The consent_token returned from /consent-challenge is passed to /install.
            var consentToken = null;       // populated on /consent-challenge if required
            var consentSatisfied = true;   // false until user passes the gate (only when consent required)
            var installBtnRef = null;      // forward ref so consent UI can enable/disable it

            function refreshInstallBtnState() {
              if (!installBtnRef) return;
              installBtnRef.disabled = !consentSatisfied;
            }

            // Async: fetch consent challenge (non-blocking; install button starts disabled if required)
            fetch(API + "/consent-challenge/" + encodeURIComponent(id) + "?lang=" + encodeURIComponent('${lang}'))
              .then(function(r) { return r.json(); })
              .then(function(data) {
                if (!data || data.required === false) return; // no consent required
                consentSatisfied = false; // gate the install button
                refreshInstallBtnState();
                consentToken = data.token;

                var box = document.createElement("div");
                var isPriv = data.privileged === true;
                var bg = isPriv ? "rgba(231,76,60,0.10)" : "rgba(240,173,78,0.10)";
                var bd = isPriv ? "rgba(231,76,60,0.35)" : "rgba(240,173,78,0.35)";
                var color = isPriv ? "#e74c3c" : "#f0ad4e";
                box.style.cssText = "background:" + bg + ";border:1px solid " + bd + ";border-radius:6px;padding:0.85rem 1rem;margin-bottom:1rem";

                var title = document.createElement("div");
                title.style.cssText = "font-weight:600;color:" + color + ";margin-bottom:0.5rem;font-size:0.95rem";
                title.textContent = isPriv
                  ? "Privileged bundle — explicit consent required"
                  : "Consent required";
                box.appendChild(title);

                var msg = document.createElement("div");
                msg.style.cssText = "color:var(--crow-text-secondary);font-size:0.85rem;line-height:1.5;margin-bottom:0.6rem;white-space:pre-wrap";
                msg.textContent = data.message || "";
                box.appendChild(msg);

                if (Array.isArray(data.capabilities) && data.capabilities.length > 0) {
                  var capLabel = document.createElement("div");
                  capLabel.style.cssText = "font-size:0.78rem;color:var(--crow-text-muted);text-transform:uppercase;letter-spacing:0.05em;margin:0.5rem 0 0.25rem";
                  capLabel.textContent = "Capabilities";
                  box.appendChild(capLabel);

                  var capList = document.createElement("ul");
                  capList.style.cssText = "margin:0 0 0.5rem 1.25rem;color:var(--crow-text-secondary);font-size:0.85rem;line-height:1.5";
                  data.capabilities.forEach(function(c) {
                    var li = document.createElement("li");
                    li.textContent = c;
                    capList.appendChild(li);
                  });
                  box.appendChild(capList);
                }

                if (Array.isArray(data.prereqs) && data.prereqs.length > 0) {
                  var preqLabel = document.createElement("div");
                  preqLabel.style.cssText = "font-size:0.78rem;color:var(--crow-text-muted);text-transform:uppercase;letter-spacing:0.05em;margin:0.5rem 0 0.25rem";
                  preqLabel.textContent = "Required bundles";
                  box.appendChild(preqLabel);

                  var anyMissing = false;
                  var preqList = document.createElement("ul");
                  preqList.style.cssText = "margin:0 0 0.5rem 1.25rem;font-size:0.85rem;line-height:1.5";
                  data.prereqs.forEach(function(p) {
                    var li = document.createElement("li");
                    li.style.color = p.installed ? "var(--crow-success, #2ecc71)" : "var(--crow-error, #e74c3c)";
                    li.textContent = (p.installed ? "✓ " : "✗ ") + p.id + (p.installed ? " (installed)" : " (NOT installed — install this first)");
                    if (!p.installed) anyMissing = true;
                    preqList.appendChild(li);
                  });
                  box.appendChild(preqList);
                  if (anyMissing) {
                    consentSatisfied = false;
                    refreshInstallBtnState();
                  }
                }

                // Consent gate: checkbox + (for privileged) typed confirmation
                var gate = document.createElement("div");
                gate.style.cssText = "margin-top:0.5rem";

                var checkLabel = document.createElement("label");
                checkLabel.style.cssText = "display:flex;align-items:center;gap:0.4rem;font-size:0.88rem;color:var(--crow-text-secondary);cursor:pointer;margin-bottom:0.4rem";
                var check = document.createElement("input");
                check.type = "checkbox";
                checkLabel.appendChild(check);
                checkLabel.appendChild(document.createTextNode(" I understand and consent"));
                gate.appendChild(checkLabel);

                var confirmInput = null;
                if (isPriv) {
                  var confirmLabel = document.createElement("label");
                  confirmLabel.style.cssText = "display:block;font-size:0.78rem;color:var(--crow-text-muted);text-transform:uppercase;letter-spacing:0.05em;margin:0.4rem 0 0.2rem";
                  confirmLabel.textContent = 'Type "INSTALL" to confirm';
                  gate.appendChild(confirmLabel);
                  confirmInput = document.createElement("input");
                  confirmInput.type = "text";
                  confirmInput.placeholder = "INSTALL";
                  confirmInput.style.cssText = "width:100%;padding:0.45rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg-deep);color:var(--crow-text-primary);font-family:JetBrains Mono,monospace;font-size:0.85rem;box-sizing:border-box";
                  gate.appendChild(confirmInput);
                }

                function evaluateGate() {
                  var ok = check.checked;
                  if (isPriv && confirmInput) {
                    ok = ok && (confirmInput.value || "").trim().toLowerCase() === "install";
                  }
                  // dependents must also be installed
                  if (Array.isArray(data.prereqs)) {
                    for (var i = 0; i < data.prereqs.length; i++) {
                      if (!data.prereqs[i].installed) ok = false;
                    }
                  }
                  consentSatisfied = ok;
                  refreshInstallBtnState();
                }

                check.addEventListener("change", evaluateGate);
                if (confirmInput) confirmInput.addEventListener("input", evaluateGate);
                box.appendChild(gate);

                // Insert consent box right after the heading
                frag.insertBefore(box, frag.children[1] || null);
              })
              .catch(function() {
                // Network error — leave install enabled (fail-open). The server will reject
                // the install if consent is actually required (no token) so it's safe.
              });

            if (isCommunity) {
              var communityWarn = document.createElement("div");
              communityWarn.style.cssText = "background:rgba(240,173,78,0.1);border:1px solid rgba(240,173,78,0.3);border-radius:6px;padding:0.75rem 1rem;margin-bottom:1rem";
              var cwTitle = document.createElement("div");
              cwTitle.style.cssText = "font-weight:600;color:#f0ad4e;margin-bottom:0.25rem;font-size:0.85rem";
              cwTitle.textContent = '${tJs("extensions.communityWarningTitle", lang)}';
              communityWarn.appendChild(cwTitle);
              var cwText = document.createElement("div");
              cwText.style.cssText = "color:var(--crow-text-secondary);font-size:0.8rem";
              cwText.textContent = '${tJs("extensions.communityWarningDesc", lang)}';
              communityWarn.appendChild(cwText);
              frag.appendChild(communityWarn);
            }

            var desc = document.createElement("p");
            desc.style.cssText = "color:var(--crow-text-secondary);font-size:0.9rem;margin-bottom:1rem";
            desc.textContent = '${tJs("extensions.installDesc", lang)}';
            frag.appendChild(desc);

            if (minRam > 0 || minDisk > 0) {
              var warnDiv = document.createElement("div");
              warnDiv.id = "resource-warning";
              warnDiv.style.cssText = "font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.75rem";
              warnDiv.textContent = '${tJs("extensions.working", lang)}';
              frag.appendChild(warnDiv);
              fetch(API + "/status").then(function(r) { return r.json(); }).catch(function() { return null; }).then(function() {
                fetch("/api/health").then(function(r) { return r.json(); }).then(function(h) {
                  var warnings = [];
                  if (minRam > 0 && h && h.ram_free_mb && h.ram_free_mb < minRam) {
                    warnings.push('${tJs("extensions.needsRam", lang)}' + minRam + '${tJs("extensions.ramFree", lang)}' + " " + h.ram_free_mb + '${tJs("extensions.mbFree", lang)}');
                  }
                  if (minDisk > 0 && h && h.disk_free_mb && h.disk_free_mb < minDisk) {
                    warnings.push('${tJs("extensions.needsDisk", lang)}' + minDisk + '${tJs("extensions.diskFree", lang)}' + " " + h.disk_free_mb + '${tJs("extensions.mbFree", lang)}');
                  }
                  if (warnings.length > 0) {
                    warnDiv.style.cssText = "font-size:0.8rem;color:var(--crow-warning, #f0ad4e);background:rgba(240,173,78,0.1);padding:0.75rem;border-radius:4px;margin-bottom:0.75rem;border:1px solid rgba(240,173,78,0.3)";
                    warnDiv.textContent = warnings.join(" ") + " " + '${tJs("extensions.installMayCauseInstability", lang)}';
                  } else {
                    warnDiv.style.display = "none";
                  }
                }).catch(function() { warnDiv.style.display = "none"; });
              });
            }

            var envNames = [];
            if (envVars.length > 0) {
              var configH = document.createElement("h4");
              configH.style.cssText = "margin:0 0 0.5rem;font-size:0.9rem;color:var(--crow-text-secondary)";
              configH.textContent = '${tJs("extensions.configuration", lang)}';
              frag.appendChild(configH);

              envVars.forEach(function(ev) {
                envNames.push(ev.name);
                var wrap = document.createElement("div");
                wrap.style.marginBottom = "0.75rem";

                var label = document.createElement("label");
                label.style.cssText = "display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.25rem;text-transform:uppercase;letter-spacing:0.05em";
                label.textContent = ev.name + (ev.required ? " *" : "");
                wrap.appendChild(label);

                var input = document.createElement("input");
                input.type = ev.secret ? "password" : "text";
                input.id = "env_" + ev.name;
                input.value = ev.default || "";
                input.placeholder = ev.description || "";
                input.style.cssText = "width:100%;padding:0.5rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg-deep);color:var(--crow-text-primary);font-family:JetBrains Mono,monospace;font-size:0.85rem;box-sizing:border-box";
                wrap.appendChild(input);

                var hint = document.createElement("div");
                hint.style.cssText = "font-size:0.7rem;color:var(--crow-text-muted);margin-top:0.2rem";
                hint.textContent = ev.description || "";
                wrap.appendChild(hint);

                frag.appendChild(wrap);
              });
            }

            var statusDiv = document.createElement("div");
            statusDiv.id = "install-status";
            statusDiv.style.cssText = "font-size:0.85rem;margin:0.75rem 0;display:none";
            frag.appendChild(statusDiv);

            var btnRow = document.createElement("div");
            btnRow.style.cssText = "display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem";

            var cancelBtn = document.createElement("button");
            cancelBtn.className = "btn btn-secondary";
            cancelBtn.textContent = '${tJs("common.cancel", lang)}';
            cancelBtn.addEventListener("click", hideModal);
            btnRow.appendChild(cancelBtn);

            var installBtn = document.createElement("button");
            installBtn.className = "btn btn-primary";
            installBtn.textContent = '${tJs("extensions.install", lang)}';
            installBtnRef = installBtn;
            // Start disabled if consent is required (will be enabled when gate is satisfied);
            // initial value of consentSatisfied is true and gets flipped by the consent fetch.
            refreshInstallBtnState();
            installBtn.addEventListener("click", function() {
              installBtn.disabled = true;
              installBtn.textContent = '${tJs("extensions.installing", lang)}';
              statusDiv.style.display = "block";
              statusDiv.style.color = "var(--crow-accent)";
              statusDiv.textContent = '${tJs("extensions.copyingFiles", lang)}';

              var envData = {};
              envNames.forEach(function(n) {
                var inp = document.getElementById("env_" + n);
                if (inp && inp.value) envData[n] = inp.value;
              });

              var payload = { bundle_id: id, env_vars: envData };
              if (consentToken) payload.consent_token = consentToken;

              apiCall("install", payload).then(function(res) {
                if (res.ok && res.data.job_id) {
                  pollJob(res.data.job_id, statusDiv, installBtn);
                } else if (res.data && res.data.consent_expired) {
                  // PR 0: Consent token expired (e.g., slow image pull). Mint a fresh token
                  // silently and retry the install with the same env config preserved.
                  statusDiv.style.color = "var(--crow-warning, #f0ad4e)";
                  statusDiv.textContent = "Consent expired — refreshing and retrying...";
                  fetch(API + "/consent-challenge/" + encodeURIComponent(id) + "?lang=" + encodeURIComponent('${lang}'))
                    .then(function(r) { return r.json(); })
                    .then(function(d) {
                      if (d && d.token) {
                        consentToken = d.token;
                        installBtn.click();
                      } else {
                        statusDiv.style.color = "var(--crow-error, #e74c3c)";
                        statusDiv.textContent = "Could not refresh consent. Retry manually.";
                        installBtn.disabled = false;
                        installBtn.textContent = '${tJs("extensions.retry", lang)}';
                      }
                    });
                } else {
                  statusDiv.style.color = "var(--crow-error, #e74c3c)";
                  statusDiv.textContent = res.data.error || '${tJs("extensions.installFailed", lang)}';
                  installBtn.disabled = false;
                  installBtn.textContent = '${tJs("extensions.retry", lang)}';
                }
              }).catch(function() {
                statusDiv.style.color = "var(--crow-error, #e74c3c)";
                statusDiv.textContent = '${tJs("extensions.networkError", lang)}';
                installBtn.disabled = false;
                installBtn.textContent = '${tJs("extensions.retry", lang)}';
              });
            });
            btnRow.appendChild(installBtn);
            frag.appendChild(btnRow);

            setModalContent(frag);
            showModal();
        }

        document.querySelectorAll(".bundle-install").forEach(function(btn) {
          btn.addEventListener("click", function(e) {
            e.stopPropagation();
            showInstallModal(this.dataset.id, this.dataset.name,
              JSON.parse(this.dataset.envvars || "[]"),
              parseInt(this.dataset.minram || "0", 10),
              parseInt(this.dataset.mindisk || "0", 10),
              this.dataset.community === "true");
          });
        });

        // --- Uninstall modal ---
        document.querySelectorAll(".bundle-uninstall").forEach(function(btn) {
          btn.addEventListener("click", function() {
            var id = this.dataset.id;
            var name = this.dataset.name;
            var isDocker = this.dataset.docker === "true";

            var frag = document.createElement("div");

            var h3 = document.createElement("h3");
            h3.style.cssText = "font-family:Fraunces,serif;margin-bottom:0.75rem";
            h3.textContent = '${tJs("extensions.remove", lang)}' + " " + name + "?";
            frag.appendChild(h3);

            var warnBox = document.createElement("div");
            warnBox.style.cssText = "background:rgba(231,76,60,0.08);border:1px solid rgba(231,76,60,0.25);border-radius:6px;padding:0.75rem 1rem;margin-bottom:1rem;box-sizing:border-box";

            var warnTitle = document.createElement("div");
            warnTitle.style.cssText = "font-weight:600;color:var(--crow-error, #e74c3c);margin-bottom:0.35rem;font-size:0.9rem";
            warnTitle.textContent = '${tJs("extensions.cannotBeUndone", lang)}';
            warnBox.appendChild(warnTitle);

            var warnText = document.createElement("div");
            warnText.style.cssText = "color:var(--crow-text-secondary);font-size:0.85rem;line-height:1.5";
            warnText.textContent = isDocker
              ? '${tJs("extensions.uninstallDockerDesc", lang)}'
              : '${tJs("extensions.uninstallDesc", lang)}';
            warnBox.appendChild(warnText);
            frag.appendChild(warnBox);

            var checkId = null;
            if (isDocker) {
              var dataBox = document.createElement("div");
              dataBox.style.cssText = "background:rgba(240,173,78,0.08);border:1px solid rgba(240,173,78,0.25);border-radius:6px;padding:0.75rem 1rem;margin-bottom:0.75rem;box-sizing:border-box";

              var hint = document.createElement("div");
              hint.style.cssText = "font-size:0.8rem;color:var(--crow-text-secondary);margin-bottom:0.5rem";
              hint.textContent = '${tJs("extensions.dataDeleteHint", lang)}';
              dataBox.appendChild(hint);

              var label = document.createElement("label");
              label.style.cssText = "display:inline-flex;align-items:center;gap:0.4rem;font-size:0.85rem;color:var(--crow-text-secondary);cursor:pointer;margin:0";
              var check = document.createElement("input");
              check.type = "checkbox";
              check.id = "delete-data-check";
              checkId = check.id;
              label.appendChild(check);
              label.appendChild(document.createTextNode('${tJs("extensions.deleteStoredData", lang)}'));
              dataBox.appendChild(label);

              frag.appendChild(dataBox);
            }

            var statusDiv = document.createElement("div");
            statusDiv.style.cssText = "font-size:0.85rem;margin:0.75rem 0;display:none";
            frag.appendChild(statusDiv);

            var btnRow = document.createElement("div");
            btnRow.style.cssText = "display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem";

            var cancelBtn = document.createElement("button");
            cancelBtn.className = "btn btn-secondary";
            cancelBtn.textContent = '${tJs("common.cancel", lang)}';
            cancelBtn.addEventListener("click", hideModal);
            btnRow.appendChild(cancelBtn);

            var removeBtn = document.createElement("button");
            removeBtn.style.cssText = "background:var(--crow-error, #e74c3c);color:white;border:none";
            removeBtn.className = "btn";
            removeBtn.textContent = '${tJs("extensions.remove", lang)}';
            removeBtn.addEventListener("click", function() {
              var deleteData = checkId ? document.getElementById(checkId).checked : false;
              removeBtn.disabled = true;
              removeBtn.textContent = '${tJs("extensions.removing", lang)}';
              statusDiv.style.display = "block";
              statusDiv.style.color = "var(--crow-accent)";
              statusDiv.textContent = '${tJs("extensions.stoppingAndRemoving", lang)}';

              apiCall("uninstall", { bundle_id: id, delete_data: deleteData }).then(function(res) {
                if (res.ok && res.data.job_id) {
                  pollJob(res.data.job_id, statusDiv, removeBtn);
                } else {
                  statusDiv.style.color = "var(--crow-error, #e74c3c)";
                  statusDiv.textContent = res.data.error || '${tJs("extensions.removalFailed", lang)}';
                  removeBtn.disabled = false;
                  removeBtn.textContent = '${tJs("extensions.retry", lang)}';
                }
              }).catch(function() {
                statusDiv.style.color = "var(--crow-error, #e74c3c)";
                statusDiv.textContent = '${tJs("extensions.networkError", lang)}';
                removeBtn.disabled = false;
                removeBtn.textContent = '${tJs("extensions.retry", lang)}';
              });
            });
            btnRow.appendChild(removeBtn);
            frag.appendChild(btnRow);

            setModalContent(frag);
            showModal();
          });
        });

        // --- Wait for gateway restart ---
        function waitForRestart(statusEl) {
          statusEl.style.color = "var(--crow-accent)";
          statusEl.textContent = '${tJs("extensions.gatewayRestarting", lang)}';
          setTimeout(function pollRestart() {
            fetch("/health").then(function(r) {
              if (r.ok) location.reload();
              else setTimeout(pollRestart, 2000);
            }).catch(function() { setTimeout(pollRestart, 2000); });
          }, 3000);
        }

        // --- Job polling ---
        function pollJob(jobId, statusEl, btn) {
          fetch(API + "/jobs/" + jobId).then(function(r) { return r.json(); }).then(function(job) {
            statusEl.textContent = job.log[job.log.length - 1] || '${tJs("extensions.working", lang)}';
            if (job.status === "complete") {
              statusEl.style.color = "var(--crow-accent)";
              statusEl.textContent = '${tJs("extensions.done", lang)}';
              setTimeout(function() { location.reload(); }, 1500);
            } else if (job.status === "complete_restart") {
              statusEl.style.color = "var(--crow-accent)";
              var lastLog = job.log[job.log.length - 1] || "";
              var aiChatMsg = job.log.find(function(l) { return l.indexOf("AI Chat") !== -1; });
              if (aiChatMsg) {
                statusEl.textContent = aiChatMsg + " — " + '${tJs("extensions.restartingGatewayChanges", lang)}';
              } else {
                statusEl.textContent = '${tJs("extensions.gatewayRestarting", lang)}';
              }
              fetch(API + "/restart", { method: "POST", headers: { "Content-Type": "application/json" } }).catch(function() {});
              waitForRestart(statusEl);
            } else if (job.status === "failed") {
              statusEl.style.color = "var(--crow-error, #e74c3c)";
              statusEl.textContent = '${tJs("extensions.failed", lang)}' + " " + (job.log[job.log.length - 1] || '${tJs("extensions.unknownError", lang)}');
              btn.disabled = false;
              btn.textContent = '${tJs("extensions.retry", lang)}';
            } else {
              setTimeout(function() { pollJob(jobId, statusEl, btn); }, 1000);
            }
          }).catch(function() {
            waitForRestart(statusEl);
          });
        }

        // --- Category filter tabs ---
        function applyFilters() {
          var activeTab = document.querySelector(".ext-tab--active");
          var cat = activeTab ? activeTab.dataset.category : "all";
          var searchInput = document.getElementById("ext-search");
          var q = searchInput ? searchInput.value.toLowerCase().trim() : "";

          document.querySelectorAll(".addon-card").forEach(function(card) {
            var catMatch = cat === "all" || card.dataset.addonCategory === cat;
            var searchMatch = !q
              || (card.dataset.addonName || "").indexOf(q) !== -1
              || (card.dataset.addonDesc || "").indexOf(q) !== -1
              || (card.dataset.addonTags || "").indexOf(q) !== -1;
            card.style.display = (catMatch && searchMatch) ? "" : "none";
          });
        }

        document.querySelectorAll(".ext-tab").forEach(function(btn) {
          btn.addEventListener("click", function() {
            document.querySelectorAll(".ext-tab").forEach(function(b) { b.classList.remove("ext-tab--active"); });
            this.classList.add("ext-tab--active");
            applyFilters();
          });
        });

        // --- Search ---
        var searchInput = document.getElementById("ext-search");
        if (searchInput) {
          searchInput.addEventListener("input", applyFilters);
        }

        // --- Detail modal ---
        var ADDON_DATA = (function() {
          var el = document.getElementById("addon-registry");
          if (!el) return {};
          try { return JSON.parse(el.textContent); } catch(e) { return {}; }
        })();

        function showDetailModal(addon) {
          var frag = document.createElement("div");
          frag.style.position = "relative";

          // Close button
          var closeBtn = document.createElement("button");
          closeBtn.className = "ext-detail__close";
          closeBtn.textContent = "\\u00D7";
          closeBtn.setAttribute("aria-label", "${tJs("extensions.close", lang)}");
          closeBtn.addEventListener("click", hideModal);
          frag.appendChild(closeBtn);

          // Header: icon + info
          var header = document.createElement("div");
          header.className = "ext-detail__header";

          var iconWrap = document.createElement("div");
          iconWrap.className = "ext-detail__icon";
          iconWrap.style.cssText = "background:" + (addon._iconBg || "var(--crow-bg-elevated)") + ";color:" + (addon._iconColor || "var(--crow-accent)");
          // Safety: _iconHtml is server-generated from hardcoded SVG dictionary in logos.js.
          // getAddonLogo() returns null for unknown IDs; community addons get emoji/letter fallback.
          // No user-supplied content reaches innerHTML here.
          iconWrap.innerHTML = addon._iconHtml || "";
          header.appendChild(iconWrap);

          var info = document.createElement("div");
          info.className = "ext-detail__info";

          var title = document.createElement("h3");
          title.className = "ext-detail__title";
          title.textContent = addon.name || addon.id;
          info.appendChild(title);

          var author = document.createElement("div");
          author.className = "ext-detail__author";
          author.textContent = "v" + (addon.version || "1.0.0") + " \\u00B7 " + (addon.author || "community");
          info.appendChild(author);

          header.appendChild(info);
          frag.appendChild(header);

          // Badges
          var badges = document.createElement("div");
          badges.className = "ext-detail__badges";

          var catBadge = document.createElement("span");
          catBadge.className = "ext-card__badge";
          catBadge.style.cssText = "color:" + (addon._iconColor || "var(--crow-accent)") + ";background:" + (addon._iconBg || "var(--crow-accent-muted)");
          catBadge.textContent = addon.category || "other";
          badges.appendChild(catBadge);

          var typeBadge = document.createElement("span");
          typeBadge.className = "ext-card__badge ext-card__badge--type";
          typeBadge.textContent = addon.type || "bundle";
          badges.appendChild(typeBadge);

          var officialBadge = document.createElement("span");
          officialBadge.className = addon.official ? "ext-card__badge ext-card__badge--official" : "ext-card__badge ext-card__badge--community";
          officialBadge.textContent = addon.official ? '${tJs("extensions.official", lang)}' : '${tJs("extensions.community", lang)}';
          badges.appendChild(officialBadge);

          frag.appendChild(badges);

          // Description
          var descP = document.createElement("p");
          descP.className = "ext-detail__desc";
          descP.textContent = addon.description || "";
          frag.appendChild(descP);

          // Tags
          if (addon.tags && addon.tags.length > 0) {
            var tagSection = document.createElement("div");
            tagSection.className = "ext-detail__section";
            var tagTitle = document.createElement("div");
            tagTitle.className = "ext-detail__section-title";
            tagTitle.textContent = '${tJs("extensions.tags", lang)}';
            tagSection.appendChild(tagTitle);
            var tagWrap = document.createElement("div");
            tagWrap.className = "ext-detail__tags";
            addon.tags.forEach(function(tag) {
              var chip = document.createElement("span");
              chip.className = "ext-detail__tag";
              chip.textContent = tag;
              tagWrap.appendChild(chip);
            });
            tagSection.appendChild(tagWrap);
            frag.appendChild(tagSection);
          }

          // Requirements
          var req = addon.requires || {};
          if (req.min_ram_mb || req.min_disk_mb || req.gpu || req.min_vram_gb) {
            var reqSection = document.createElement("div");
            reqSection.className = "ext-detail__section";
            var reqTitle = document.createElement("div");
            reqTitle.className = "ext-detail__section-title";
            reqTitle.textContent = '${tJs("extensions.requirements", lang)}';
            reqSection.appendChild(reqTitle);
            var reqWrap = document.createElement("div");
            reqWrap.className = "ext-detail__req";
            if (req.min_ram_mb) {
              var ramChip = document.createElement("span");
              ramChip.className = "ext-detail__req-chip";
              ramChip.textContent = (req.min_ram_mb >= 1024 ? Math.floor(req.min_ram_mb / 1024) + "GB" : req.min_ram_mb + "MB") + " RAM";
              reqWrap.appendChild(ramChip);
            }
            if (req.min_disk_mb) {
              var diskChip = document.createElement("span");
              diskChip.className = "ext-detail__req-chip";
              diskChip.textContent = (req.min_disk_mb >= 1024 ? Math.floor(req.min_disk_mb / 1024) + "GB" : req.min_disk_mb + "MB") + " disk";
              reqWrap.appendChild(diskChip);
            }
            if (req.min_vram_gb) {
              var vramChip = document.createElement("span");
              vramChip.className = "ext-detail__req-chip";
              vramChip.textContent = req.min_vram_gb + "GB VRAM";
              reqWrap.appendChild(vramChip);
            }
            if (req.gpu) {
              var gpuChip = document.createElement("span");
              gpuChip.className = "ext-detail__req-chip";
              gpuChip.style.cssText = "color:var(--crow-accent);border:1px solid var(--crow-accent)";
              gpuChip.textContent = '${tJs("extensions.gpuRequired", lang)}';
              reqWrap.appendChild(gpuChip);
            }
            reqSection.appendChild(reqWrap);
            frag.appendChild(reqSection);
          }

          // Ports
          if (addon.ports && addon.ports.length > 0) {
            var portSection = document.createElement("div");
            portSection.className = "ext-detail__section";
            var portTitle = document.createElement("div");
            portTitle.className = "ext-detail__section-title";
            portTitle.textContent = '${tJs("extensions.ports", lang)}';
            portSection.appendChild(portTitle);
            var portWrap = document.createElement("div");
            portWrap.className = "ext-detail__req";
            addon.ports.forEach(function(p) {
              var chip = document.createElement("span");
              chip.className = "ext-detail__req-chip";
              chip.textContent = p;
              portWrap.appendChild(chip);
            });
            portSection.appendChild(portWrap);
            frag.appendChild(portSection);
          }

          // Web UI
          if (addon.webUI) {
            var uiSection = document.createElement("div");
            uiSection.className = "ext-detail__section";
            var uiTitle = document.createElement("div");
            uiTitle.className = "ext-detail__section-title";
            uiTitle.textContent = '${tJs("extensions.webInterface", lang)}';
            uiSection.appendChild(uiTitle);
            var uiChip = document.createElement("span");
            uiChip.className = "ext-detail__req-chip";
            uiChip.textContent = (addon.webUI.label || "Web UI") + " :" + (addon.webUI.port || "") + (addon.webUI.path || "/");
            uiSection.appendChild(uiChip);
            frag.appendChild(uiSection);
          }

          // Notes
          if (addon.notes) {
            var noteSection = document.createElement("div");
            noteSection.className = "ext-detail__section";
            var noteTitle = document.createElement("div");
            noteTitle.className = "ext-detail__section-title";
            noteTitle.textContent = '${tJs("extensions.notes", lang)}';
            noteSection.appendChild(noteTitle);
            var noteBox = document.createElement("div");
            noteBox.className = "ext-detail__notes";
            noteBox.textContent = addon.notes;
            noteSection.appendChild(noteBox);
            frag.appendChild(noteSection);
          }

          // Actions
          var actions = document.createElement("div");
          actions.className = "ext-detail__actions";

          var closeAction = document.createElement("button");
          closeAction.className = "btn btn-secondary";
          closeAction.textContent = '${tJs("extensions.close", lang)}';
          closeAction.addEventListener("click", hideModal);
          actions.appendChild(closeAction);

          if (!addon._installed) {
            var installAction = document.createElement("button");
            installAction.className = "btn btn-primary";
            installAction.textContent = '${tJs("extensions.install", lang)}';
            installAction.addEventListener("click", function() {
              hideModal();
              showInstallModal(addon.id, addon.name, addon.env_vars || [],
                (addon.requires || {}).min_ram_mb || 0,
                (addon.requires || {}).min_disk_mb || 0,
                !addon.official);
            });
            actions.appendChild(installAction);
          } else {
            var installedBadge = document.createElement("span");
            installedBadge.className = "badge badge--published";
            installedBadge.style.cssText = "display:flex;align-items:center;padding:0.3rem 0.8rem;font-size:0.85rem";
            installedBadge.textContent = '${tJs("extensions.installedBadge", lang)}';
            actions.appendChild(installedBadge);
          }

          frag.appendChild(actions);
          setModalContent(frag);
          showModal();
        }

        // --- Card click → detail modal ---
        document.querySelectorAll(".addon-card").forEach(function(card) {
          card.style.cursor = "pointer";
          card.addEventListener("click", function(e) {
            if (e.target.closest(".bundle-install") || e.target.closest(".btn")) return;
            var id = card.dataset.addonId;
            var addon = ADDON_DATA[id];
            if (addon) showDetailModal(addon);
          });
        });

        document.querySelectorAll(".ext-installed__item").forEach(function(item) {
          item.style.cursor = "pointer";
          item.addEventListener("click", function(e) {
            if (e.target.closest(".bundle-action") || e.target.closest(".bundle-uninstall") || e.target.closest(".btn")) return;
            var id = item.dataset.addonId;
            var addon = ADDON_DATA[id];
            if (addon) showDetailModal(addon);
          });
        });

        // --- Escape key --- attach once per document lifetime so Turbo
        // re-entries don't stack keydown listeners. The modal lookup is
        // by id so it works against whichever overlay is currently mounted.
        if (!window.__extEscapeBound) {
          window.__extEscapeBound = true;
          document.addEventListener("keydown", function(e) {
            var overlay = document.getElementById("modal-overlay");
            if (e.key === "Escape" && overlay && overlay.style.display === "flex") {
              hideModal();
            }
          });
        }
      })();
    <\/script>`;
}
