/**
 * Perch panel — the dashboard's nav entry for the Perch Hub bundle
 * (Perch Hub Phase 1, Task C-7).
 *
 * Perch itself is a vendored pi-lab hub supervised by the gateway
 * (`servers/gateway/perch-runtime.js`) and reachable only through the
 * session-gated extension proxy at `/proxy/perch-hub`. This panel is the
 * thin, honest wrapper around that: it never pretends, and it renders
 * exactly one of three states.
 *
 *   1. running        → a full-height iframe of the bots lens
 *                       (`/proxy/perch-hub/bots`).
 *   2. installed, down → "Perch is offline" plus the supervisor's own
 *                       `lastError` and a retry hint. NEVER an iframe: a
 *                       framed dead upstream renders the proxy's error page
 *                       inside the dashboard chrome, which reads as "Crow is
 *                       broken" rather than "this one child is down".
 *   3. not installed  → a gate card with one-click install, the C4
 *                       engine-gate modal's job client re-pointed at bundle
 *                       id `perch-hub`.
 *
 * Why the install affordance lives HERE and not in the lens (PL-2 finding
 * #2): the bots-lens page is served by the hub THROUGH the proxy, so it is
 * a different document and structurally cannot reach a Crow dashboard
 * component. This panel is a real dashboard component. That is the intended
 * division of labor — the lens tells the truth in prose, the panel offers
 * the button.
 *
 * Two sources of truth, deliberately kept separate (C-2 finding #3):
 * `perchRuntimeStatus()` reports the SUPERVISOR's view, sampled when
 * `initPerchRuntime` last ran at gateway boot; the payload entrypoint on
 * disk reports what is installed RIGHT NOW. They diverge in one real,
 * common window — a webUI bundle install sets `needsRestart` (C-3), so
 * between the install and the restart the supervisor has never seen the
 * bundle. Reading disk per call (the fediverse #230 idiom: no restart
 * needed for the nav entry to appear) means an already-installed Perch is
 * never offered an install button; it is honestly reported as down.
 *
 * ABSOLUTE RULE for the client script below (matches
 * bot-builder/engine-gate-client.js and extensions/client.js): the emitted
 * <script> body is built inside a template literal and must never contain a
 * literal backtick — not even in a comment. ES5 throughout (var, function
 * expressions); it ships unbundled straight to the browser. Every dynamic
 * string it writes into the DOM goes through textContent, never innerHTML.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { escapeHtml } from "../shared/components.js";
import { t, tJs } from "../shared/i18n.js";
import { PERCH_BUNDLE_ID, perchRuntimeStatus } from "../../perch-runtime.js";

/** Where the bots lens lives once the hub is up. The proxy path is
 * `/proxy/<bundle id>` (`routes/extension-proxy.js`) and the prefix is
 * STRIPPED before the hub sees the request — the hub matches a bare
 * `/bots` and emits prefixed urls via PERCH_BASE_PATH (PL-1 finding #1). */
export const PERCH_LENS_PATH = `/proxy/${PERCH_BUNDLE_ID}/bots`;

/** Payload entrypoint, the same file `initPerchRuntime` gates on. */
function payloadEntrypoint(crowHome) {
  return join(crowHome, "bundles", PERCH_BUNDLE_ID, "payload", "hub", "server.mjs");
}

/**
 * Is the perch-hub bundle installed on this instance?
 *
 * Disk first (call-time CROW_HOME, so a fresh install shows up with no
 * restart), supervisor second (it may have started from a payload this
 * process can no longer stat — e.g. an uninstall that raced a live child).
 * Either "yes" is a yes: the only decision riding on this is whether to
 * offer an INSTALL, and offering to install something already installed is
 * the one answer that is always wrong.
 *
 * @param {object} [opts]
 * @param {string} [opts.crowHome] defaults to `process.env.CROW_HOME` (then `~/.crow`)
 * @param {object} [opts.status] defaults to `perchRuntimeStatus()`
 */
export function perchInstalled({
  crowHome = process.env.CROW_HOME || join(homedir(), ".crow"),
  status = perchRuntimeStatus(),
} = {}) {
  try {
    if (existsSync(payloadEntrypoint(crowHome))) return true;
  } catch { /* unreadable CROW_HOME — fall through to the supervisor's view */ }
  return !!(status && status.installed);
}

/**
 * @param {object} [opts]
 * @param {object} [opts.status] defaults to `perchRuntimeStatus()`
 * @param {boolean} [opts.installed] defaults to `perchInstalled({ status })`
 * @returns {"running"|"offline"|"not_installed"}
 */
export function perchPanelState({
  status = perchRuntimeStatus(),
  installed = perchInstalled({ status }),
} = {}) {
  if (!installed) return "not_installed";
  return status && status.running ? "running" : "offline";
}

function perchStyles() {
  return `<style>
    .perch-root { display: flex; flex-direction: column; gap: var(--crow-space-4, 1rem); }
    .perch-frame-wrap { border: 1px solid var(--crow-border); border-radius: 8px; overflow: hidden;
      height: calc(100vh - 190px); min-height: 480px; background: var(--crow-bg); }
    .perch-frame { width: 100%; height: 100%; border: none; display: block; }
    .perch-bar { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; }
    .perch-bar h1 { font-family: Fraunces, serif; margin: 0; font-size: 1.4rem; }
    .perch-sub { color: var(--crow-text-secondary); font-size: .85rem; margin: 0; }
    .perch-card { border: 1px solid var(--crow-border); border-radius: 8px; padding: 1.25rem; max-width: 46rem; }
    .perch-card h2 { font-family: Fraunces, serif; margin: 0 0 .6rem; font-size: 1.15rem; }
    .perch-card p { color: var(--crow-text-secondary); font-size: .9rem; margin: 0 0 .7rem; }
    .perch-note { color: var(--crow-text-muted); font-size: .8rem; }
    .perch-err-label { color: var(--crow-text-muted); font-size: .75rem; text-transform: uppercase;
      letter-spacing: .04em; margin: .9rem 0 .25rem; }
    .perch-err { font-family: ui-monospace, monospace; font-size: .78rem; color: var(--crow-error, #e74c3c);
      background: var(--crow-bg); border: 1px solid var(--crow-border); border-radius: 6px;
      padding: .5rem .65rem; margin: 0 0 .7rem; white-space: pre-wrap; word-break: break-word; }
    .perch-status { font-size: .85rem; margin: .75rem 0 0; min-height: 1.1em; }
  </style>`;
}

/** State 1 — the hub is up: frame the bots lens. */
function renderRunning(lang) {
  return `<div class="perch-root">
    <div class="perch-bar">
      <div>
        <h1>${escapeHtml(t("perch.runningTitle", lang))}</h1>
        <p class="perch-sub">${escapeHtml(t("perch.runningSubtitle", lang))}</p>
      </div>
      <a class="btn btn-secondary" href="${PERCH_LENS_PATH}" target="_blank" rel="noopener">${escapeHtml(t("perch.openInTab", lang))}</a>
    </div>
    <div class="perch-frame-wrap">
      <iframe class="perch-frame" src="${PERCH_LENS_PATH}" title="${escapeHtml(t("perch.frameLabel", lang))}"></iframe>
    </div>
  </div>`;
}

/** State 2 — installed, but the supervised child is not live. */
function renderOffline(lang, status) {
  const lastError = status && status.lastError ? String(status.lastError) : "";
  const errBlock = lastError
    ? `<p class="perch-err-label">${escapeHtml(t("perch.offlineErrorLabel", lang))}</p>` +
      `<pre class="perch-err">${escapeHtml(lastError)}</pre>`
    : `<p class="perch-note">${escapeHtml(t("perch.offlineNoError", lang))}</p>`;
  return `<div class="perch-root"><div class="perch-card">
    <h2>${escapeHtml(t("perch.offlineTitle", lang))}</h2>
    <p>${escapeHtml(t("perch.offlineBody", lang))}</p>
    ${errBlock}
    <p class="perch-note">${escapeHtml(t("perch.offlineHint", lang))}</p>
    <p><a class="btn btn-secondary" href="/dashboard/perch">${escapeHtml(t("perch.offlineRetryBtn", lang))}</a></p>
  </div></div>`;
}

/** State 3 — not installed: the gate card. */
function renderGate(lang) {
  return `<div class="perch-root"><div class="perch-card">
    <h2>${escapeHtml(t("perch.gateTitle", lang))}</h2>
    <p>${escapeHtml(t("perch.gateBody", lang))}</p>
    <p class="perch-note">${escapeHtml(t("perch.gateDiskNote", lang))}</p>
    <button type="button" id="perch-install-btn" class="btn btn-primary">${escapeHtml(t("perch.gateInstallBtn", lang))}</button>
    <p class="perch-status" id="perch-install-status"></p>
  </div></div>${perchGateClientJS(lang)}`;
}

/**
 * The gate card's client script — the C4 engine-gate job client, re-pointed
 * at `perch-hub`. Exported so tests can execute it against a DOM instead of
 * regexing its source.
 *
 * perch-hub carries a `webUI` block, so its install ALWAYS ends in
 * `complete_restart` (C-3 wired `needsRestart` for webUI manifests: the
 * proxy route table and the supervisor are both built at boot). The client
 * therefore has to drive the restart itself and wait the gateway back up,
 * exactly as extensions/client.js does — an install that "succeeded" but
 * left the operator on a page whose nav still has no Perch entry would be
 * the same dishonesty this panel exists to avoid.
 */
export function perchGateClientJS(lang) {
  return `
    <script>
      (function () {
        var API = "/dashboard/bundles/api";
        var BUNDLE_ID = "${PERCH_BUNDLE_ID}";
        var btn = document.getElementById("perch-install-btn");
        var statusEl = document.getElementById("perch-install-status");
        if (!btn || !statusEl) return;

        function say(text, isError) {
          statusEl.textContent = text;
          statusEl.style.color = isError ? "var(--crow-error, #e74c3c)" : "var(--crow-accent)";
        }

        function rearm(text) {
          say(text, true);
          btn.disabled = false;
          btn.textContent = '${tJs("perch.gateRetryBtn", lang)}';
        }

        // The gateway is going down and coming back; poll /health until it
        // answers, then reload so the nav picks up the new panel.
        function waitForRestart() {
          say('${tJs("perch.gateRestarting", lang)}', false);
          setTimeout(function poll() {
            fetch("/health").then(function (r) {
              if (r.ok) location.reload();
              else setTimeout(poll, 2000);
            }).catch(function () { setTimeout(poll, 2000); });
          }, 3000);
        }

        function pollJob(jobId) {
          fetch(API + "/jobs/" + jobId).then(function (r) { return r.json(); }).then(function (job) {
            var log = (job && job.log) || [];
            if (job.status === "complete") {
              say('${tJs("perch.gateDone", lang)}', false);
              setTimeout(function () { location.reload(); }, 1200);
            } else if (job.status === "complete_restart") {
              say('${tJs("perch.gateDone", lang)}', false);
              fetch(API + "/restart", { method: "POST", headers: { "Content-Type": "application/json" } })
                .catch(function () {});
              waitForRestart();
            } else if (job.status === "failed") {
              rearm('${tJs("perch.gateFailedPrefix", lang)}' + " " +
                (log[log.length - 1] || '${tJs("perch.gateUnknownError", lang)}'));
            } else {
              say(log[log.length - 1] || '${tJs("perch.gateWorking", lang)}', false);
              setTimeout(function () { pollJob(jobId); }, 1000);
            }
          }).catch(function () {
            // A dropped connection here is usually the restart itself.
            setTimeout(function () { pollJob(jobId); }, 3000);
          });
        }

        btn.addEventListener("click", function () {
          btn.disabled = true;
          btn.textContent = '${tJs("perch.gateInstallingBtn", lang)}';
          say('${tJs("perch.gateWorking", lang)}', false);

          fetch(API + "/install", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bundle_id: BUNDLE_ID, env_vars: {} }),
          }).then(function (r) {
            return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
          }).then(function (res) {
            var jobId = res.data && res.data.job_id;
            if (jobId && (res.ok || (res.status === 409 && res.data.code === "already_installing"))) {
              pollJob(jobId);
              return;
            }
            rearm('${tJs("perch.gateFailedPrefix", lang)}' + " " +
              ((res.data && res.data.error) || '${tJs("perch.gateUnknownError", lang)}'));
          }).catch(function () {
            rearm('${tJs("perch.gateNetworkError", lang)}');
          });
        });
      })();
    </script>
  `;
}

export default {
  id: "perch",
  name: "Perch",
  icon: "messages",
  route: "/dashboard/perch",
  navOrder: 16,
  // "ai" maps to the Agents nav group (nav-registry.js CATEGORY_TO_GROUP),
  // beside Bot Builder and Bot Board — Perch is a view onto their sessions.
  category: "ai",

  // Hidden until the perch-hub bundle is installed. Predicate, not boolean:
  // getVisiblePanels() re-evaluates it per nav render, so the entry appears
  // the moment the bundle lands (fediverse #230 idiom). The ROUTE stays
  // mounted either way — that is what makes the gate card reachable by
  // direct navigation, and it is the only surface offering the install.
  hidden: () => !perchInstalled(),

  async handler(req, res, { layout, lang }) {
    const status = perchRuntimeStatus();
    const state = perchPanelState({ status });
    let body;
    if (state === "running") body = renderRunning(lang);
    else if (state === "offline") body = renderOffline(lang, status);
    else body = renderGate(lang);
    return layout({ title: "Perch", content: perchStyles() + body });
  },
};
