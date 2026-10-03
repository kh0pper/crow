/**
 * Settings Section: Passwords (Crow keychain, spec §5.5).
 * Server-renders METADATA only. Every secret moves through /dashboard/keychain/api
 * (re-auth gated, audited, no-store). The client is a template literal: no backticks,
 * no backslashes, and only the ${...} interpolations below are intended.
 */
import { t, tJs, fill } from "../../shared/i18n.js";
import { escapeHtml } from "../../shared/components.js";

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>`;

/** R-B: vault saving needs the CLI AND a secure https Vaultwarden URL. */
export function vaultState(vs) {
  const ready = !!(vs && vs.installed && vs.cliPath);
  return { vaultAvailable: ready && !!vs.secure, vaultNeedsHttps: ready && !vs.secure };
}

export function renderPasswordsPage({ entries, method, vaultAvailable, vaultNeedsHttps, lang }) {
  const none = method === "none";
  const dis = none ? " disabled" : "";
  const rows = (entries || []).map((e) => {
    const ext = e.kind === "manual" ? t("passwords.manual", lang) : escapeHtml(e.bundle_id || "");
    const status = e.readable === false
      ? `<span class="pw-unreadable">${t("passwords.statusUnreadable", lang)}</span>`
      : e.status === "extension_removed" ? t("passwords.statusRemoved", lang) : t("passwords.statusActive", lang);
    // Only http(s) becomes a link: escapeHtml stops attribute breakout, not javascript: URLs.
    const url = e.url ? (/^https?:\/\//i.test(String(e.url)) ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.url)}</a>` : escapeHtml(e.url)) : "";
    const readable = e.readable !== false;
    const rdis = readable ? dis : " disabled";
    return `<tr class="pw-row" data-id="${Number(e.id)}" data-origin="${escapeHtml(e.origin || "")}" data-status="${escapeHtml(e.status || "")}">
        <td>${escapeHtml(e.label)}<div><code class="pw-secret" hidden style="font-family:'JetBrains Mono',monospace;word-break:break-all"></code></div></td>
        <td>${ext}</td>
        <td>${escapeHtml(e.username || "")}</td>
        <td style="word-break:break-all">${url}</td>
        <td>${status}</td>
        <td style="white-space:nowrap">${escapeHtml(String(e.updated_at || "").slice(0, 16).replace("T", " "))}</td>
        <td style="white-space:nowrap">
          <button type="button" class="btn btn-sm btn-secondary pw-reveal"${rdis}>${t("passwords.reveal", lang)}</button>
          <button type="button" class="btn btn-sm btn-secondary pw-copy"${rdis}>${t("passwords.copy", lang)}</button>
          ${vaultAvailable ? `<button type="button" class="btn btn-sm btn-secondary pw-vault"${rdis}>${t("passwords.vault", lang)}</button>` : ""}
          <button type="button" class="btn btn-sm btn-secondary pw-delete"${dis}>${t("passwords.delete", lang)}</button>
        </td>
      </tr>`;
  }).join("");

  const table = rows
    ? `<div class="table-scroll"><table class="pw-table" style="width:100%;border-collapse:collapse;font-size:0.85rem">
        <thead><tr>
          <th>${t("passwords.colLabel", lang)}</th><th>${t("passwords.colExtension", lang)}</th><th>${t("passwords.colUsername", lang)}</th>
          <th>${t("passwords.colUrl", lang)}</th><th>${t("passwords.colStatus", lang)}</th><th>${t("passwords.colUpdated", lang)}</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
    : `<p class="pw-empty" style="color:var(--crow-text-muted)">${t("passwords.empty", lang)}</p>`;

  const totp = method === "totp";
  const reauthInput = totp
    ? `<input id="pw-reauth-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-label="${t("passwords.reauthTotp", lang)}" placeholder="${t("passwords.reauthTotp", lang)}">`
    : `<input id="pw-reauth-input" type="password" autocomplete="current-password" aria-label="${t("passwords.reauthPassword", lang)}" placeholder="${t("passwords.reauthPassword", lang)}">`;

  const inputCss = "width:100%;padding:0.45rem;margin-bottom:0.4rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg-deep);color:var(--crow-text-primary);box-sizing:border-box";
  const noReauth = none ? `<div class="alert alert-error" id="pw-noreauth">${t("passwords.noReauth", lang)}</div>` : "";

  return `<style>
      .pw-table th { text-align:left; padding:6px 8px; color:var(--crow-text-muted); font-weight:500; font-size:0.72rem; text-transform:uppercase; }
      .pw-table td { padding:6px 8px; border-top:1px solid var(--crow-border); vertical-align:top; }
      .pw-panel { margin:1rem 0; padding:0.8rem; border:1px solid var(--crow-border); border-radius:8px; max-width:28rem; }
      .pw-panel input { ${inputCss} }
      #pw-root [hidden] { display:none !important; }
      .pw-unreadable { color:var(--crow-error,#e55); }
    </style>
    <div id="pw-root" data-method="${escapeHtml(method)}">
      <p style="color:var(--crow-text-secondary);font-size:0.9rem">${t("passwords.intro", lang)}</p>
      ${noReauth}
      ${vaultNeedsHttps ? `<p id="pw-vault-https-note" style="font-size:0.8rem;color:var(--crow-text-muted)">${t("keychain.vaultNeedsHttps", lang)}</p>` : ""}
      <p id="pw-grant" style="font-size:0.8rem;color:var(--crow-text-muted)"></p>
      ${table}
      <div id="pw-reauth" class="pw-panel" hidden>
        <strong>${t("passwords.reauthTitle", lang)}</strong>
        <p style="font-size:0.8rem;color:var(--crow-text-muted);margin:0.25rem 0 0.5rem">${t("passwords.reauthHint", lang)}</p>
        ${reauthInput}
        <div id="pw-reauth-error" role="alert" style="font-size:0.8rem;color:var(--crow-error,#e55);min-height:1em"></div>
        <button type="button" id="pw-reauth-go" class="btn btn-sm btn-primary">${t("passwords.confirm", lang)}</button>
        <button type="button" id="pw-reauth-cancel" class="btn btn-sm btn-secondary">${t("common.cancel", lang)}</button>
      </div>
      <div id="pw-vault" class="pw-panel" hidden>
        <strong>${t("passwords.vaultTitle", lang)}</strong>
        <input id="pw-vault-email" type="email" autocomplete="off" placeholder="${t("keychain.vaultEmail", lang)}" aria-label="${t("keychain.vaultEmail", lang)}">
        <input id="pw-vault-password" type="password" autocomplete="off" placeholder="${t("keychain.vaultPassword", lang)}" aria-label="${t("keychain.vaultPassword", lang)}">
        <p style="font-size:0.75rem;color:var(--crow-text-muted)">${t("keychain.vaultNote", lang)}</p>
        <div id="pw-vault-msg" role="status" style="font-size:0.8rem;min-height:1em"></div>
        <button type="button" id="pw-vault-go" class="btn btn-sm btn-primary">${t("passwords.vault", lang)}</button>
        <button type="button" id="pw-vault-cancel" class="btn btn-sm btn-secondary">${t("common.cancel", lang)}</button>
      </div>
      <h3 style="margin-top:1.5rem;font-size:1rem">${t("passwords.addTitle", lang)}</h3>
      <p style="font-size:0.8rem;color:var(--crow-text-muted)">${t("passwords.addHint", lang)}</p>
      <div class="pw-panel" id="pw-add-form">
        <input id="pw-add-label" type="text" placeholder="${t("passwords.colLabel", lang)}" aria-label="${t("passwords.colLabel", lang)}">
        <input id="pw-add-username" type="text" autocomplete="off" placeholder="${t("passwords.colUsername", lang)}" aria-label="${t("passwords.colUsername", lang)}">
        <input id="pw-add-url" type="url" placeholder="${t("passwords.colUrl", lang)}" aria-label="${t("passwords.colUrl", lang)}">
        <input id="pw-add-secret" type="password" autocomplete="new-password" placeholder="${t("passwords.secret", lang)}" aria-label="${t("passwords.secret", lang)}">
        <div id="pw-add-msg" role="status" style="font-size:0.8rem;min-height:1em"></div>
        <button type="button" id="pw-add-go" class="btn btn-sm btn-primary">${t("passwords.add", lang)}</button>
      </div>
      <h3 style="margin-top:1.5rem;font-size:1rem">${t("passwords.exportTitle", lang)}</h3>
      <p style="font-size:0.8rem;color:var(--crow-text-muted)">${t("passwords.exportHint", lang)}</p>
      <div class="pw-panel" id="pw-export-form">
        <input id="pw-export-pass" type="password" autocomplete="new-password" placeholder="${t("passwords.exportPassphrase", lang)}" aria-label="${t("passwords.exportPassphrase", lang)}">
        <input id="pw-export-confirm" type="password" autocomplete="new-password" placeholder="${t("passwords.exportConfirm", lang)}" aria-label="${t("passwords.exportConfirm", lang)}">
        <div id="pw-export-msg" role="status" style="font-size:0.8rem;min-height:1em"></div>
        <button type="button" id="pw-export-go" class="btn btn-sm btn-secondary"${dis}>${t("passwords.export", lang)}</button>
      </div>
      <div class="pw-panel" id="pw-import-form">
        <strong>${t("passwords.importTitle", lang)}</strong>
        <input id="pw-import-file" type="file" accept="application/json,.json" aria-label="${t("passwords.importFile", lang)}">
        <input id="pw-import-pass" type="password" autocomplete="off" placeholder="${t("passwords.exportPassphrase", lang)}" aria-label="${t("passwords.exportPassphrase", lang)}">
        <div id="pw-import-msg" role="status" style="font-size:0.8rem;min-height:1em"></div>
        <button type="button" id="pw-import-go" class="btn btn-sm btn-secondary"${dis}>${t("passwords.import", lang)}</button>
      </div>
      <h3 style="margin-top:1.5rem;font-size:1rem">${t("passwords.activityTitle", lang)}</h3>
      <ul id="pw-activity" style="font-size:0.8rem;color:var(--crow-text-secondary)"></ul>
    </div>`;
}

export function passwordsClientJS(lang) {
  const eventNames = ["keychain_reveal", "keychain_copy", "keychain_delete", "keychain_add", "keychain_save", "keychain_first_view", "keychain_vault_save", "keychain_reauth_ok", "keychain_reauth_failed", "keychain_reauth_lockout", "keychain_export", "keychain_import"];
  const eventMap = JSON.stringify(Object.fromEntries(eventNames.map((n) => [n, t(`passwords.event.${n}`, lang)])));
  return `<script>
    (function() {
      var API = "/dashboard/keychain/api";
      var root = document.getElementById("pw-root");
      if (!root) return;
      var METHOD = root.getAttribute("data-method");
      var EVENTS = ${eventMap};
      var pending = null;
      var vaultTarget = null;
      var shown = [];

      function post(path, body) {
        return fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
          .then(function(r) { return r.json().then(function(d) { return { status: r.status, d: d || {} }; }); });
      }
      function wipeShown() {
        shown.forEach(function(cell) { cell.textContent = ""; cell.hidden = true; });
        shown = [];
      }
      // Revealed plaintext stays on screen 30 s at most and never into bfcache (review S2).
      window.addEventListener("pagehide", wipeShown);
      // Turbo caches the live DOM on in-dashboard navigation (pagehide does not fire there), so
      // also wipe on turbo:before-cache and when the tab is hidden; both listeners remove
      // themselves on the cache event so Turbo visits never accumulate them.
      function onVis() { if (document.visibilityState === "hidden") wipeShown(); }
      function onCache() {
        wipeShown();
        document.removeEventListener("turbo:before-cache", onCache);
        document.removeEventListener("visibilitychange", onVis);
      }
      document.addEventListener("turbo:before-cache", onCache);
      document.addEventListener("visibilitychange", onVis);
      function showGrant(expiresAt) {
        if (!expiresAt) return;
        var d = new Date(expiresAt);
        var hh = String(d.getHours()); var mm = String(d.getMinutes());
        if (mm.length < 2) mm = "0" + mm;
        document.getElementById("pw-grant").textContent = '${tJs("passwords.grantActive", lang)}'.split("{time}").join(hh + ":" + mm);
      }
      function needAuth(retry) {
        pending = retry;
        var p = document.getElementById("pw-reauth");
        p.hidden = false;
        document.getElementById("pw-reauth-error").textContent = "";
        var i = document.getElementById("pw-reauth-input");
        i.value = "";
        if (i.focus) i.focus();
      }
      function guarded(path, body, onDone) {
        post(path, body).then(function(res) {
          if (res.status === 403 && res.d.code === "reauth_required") { needAuth(function() { guarded(path, body, onDone); }); return; }
          onDone(res);
        }).catch(function() { onDone({ status: 0, d: { error: '${tJs("passwords.error", lang)}' } }); });
      }

      document.getElementById("pw-reauth-go").addEventListener("click", function() {
        var input = document.getElementById("pw-reauth-input");
        var v = input.value;
        var body = METHOD === "totp" ? { totp_code: v } : { password: v };
        post("/reauth", body).then(function(res) {
          input.value = "";
          if (res.status === 200) {
            document.getElementById("pw-reauth").hidden = true;
            showGrant(res.d.expires_at);
            var next = pending; pending = null;
            if (next) next();
          } else {
            document.getElementById("pw-reauth-error").textContent = res.d.error || '${tJs("passwords.error", lang)}';
          }
        });
      });
      document.getElementById("pw-reauth-cancel").addEventListener("click", function() {
        pending = null;
        document.getElementById("pw-reauth-input").value = "";
        document.getElementById("pw-reauth").hidden = true;
      });

      document.querySelectorAll("tr.pw-row").forEach(function(row) {
        var id = Number(row.getAttribute("data-id"));
        var cell = row.querySelector(".pw-secret");
        row.querySelector(".pw-reveal").addEventListener("click", function() {
          guarded("/reveal", { id: id, purpose: "reveal" }, function(res) {
            if (res.status === 200 && typeof res.d.secret === "string") {
              cell.textContent = res.d.secret; cell.hidden = false; shown.push(cell);
              setTimeout(wipeShown, 30000);
            }
          });
        });
        var copyBtn = row.querySelector(".pw-copy");
        copyBtn.addEventListener("click", function() {
          guarded("/reveal", { id: id, purpose: "copy" }, function(res) {
            if (res.status === 200 && typeof res.d.secret === "string" && typeof navigator !== "undefined" && navigator.clipboard) {
              navigator.clipboard.writeText(res.d.secret).then(function() { copyBtn.textContent = '${tJs("passwords.copied", lang)}'; }).catch(function() {});
            }
          });
        });
        row.querySelector(".pw-delete").addEventListener("click", function() {
          var generated = row.getAttribute("data-origin") === "generated" && row.getAttribute("data-status") === "active";
          if (!confirm(generated ? '${tJs("passwords.deleteGeneratedConfirm", lang)}' : '${tJs("passwords.deleteConfirm", lang)}')) return;
          guarded("/delete", generated ? { id: id, confirm_generated: true } : { id: id }, function(res) { if (res.status === 200) row.remove(); });
        });
        var vaultBtn = row.querySelector(".pw-vault");
        if (vaultBtn) vaultBtn.addEventListener("click", function() {
          vaultTarget = id;
          document.getElementById("pw-vault-msg").textContent = "";
          document.getElementById("pw-vault").hidden = false;
        });
      });

      document.getElementById("pw-vault-go").addEventListener("click", function() {
        var em = document.getElementById("pw-vault-email");
        var pw = document.getElementById("pw-vault-password");
        var msg = document.getElementById("pw-vault-msg");
        if (!vaultTarget || !em.value || !pw.value) return;
        var body = { id: vaultTarget, vault_email: em.value, vault_password: pw.value };
        pw.value = "";
        guarded("/vault-save", body, function(res) {
          msg.textContent = res.d.ok ? '${tJs("passwords.vaultSaved", lang)}' : (res.d.reason || res.d.error || '${tJs("passwords.error", lang)}');
        });
      });
      document.getElementById("pw-vault-cancel").addEventListener("click", function() {
        document.getElementById("pw-vault-password").value = "";
        document.getElementById("pw-vault").hidden = true;
        vaultTarget = null;
      });

      document.getElementById("pw-add-go").addEventListener("click", function() {
        var label = document.getElementById("pw-add-label").value.trim();
        var secret = document.getElementById("pw-add-secret").value;
        var msg = document.getElementById("pw-add-msg");
        if (!label || !secret) { msg.textContent = '${tJs("passwords.addMissing", lang)}'; return; }
        post("/add", { label: label, username: document.getElementById("pw-add-username").value.trim(), url: document.getElementById("pw-add-url").value.trim(), secret: secret }).then(function(res) {
          document.getElementById("pw-add-secret").value = "";
          if (res.status === 200) location.reload();
          else msg.textContent = res.d.error || '${tJs("passwords.error", lang)}';
        });
      });

      document.getElementById("pw-export-go").addEventListener("click", function() {
        var p1 = document.getElementById("pw-export-pass");
        var p2 = document.getElementById("pw-export-confirm");
        var msg = document.getElementById("pw-export-msg");
        if (p1.value.length < 12) { msg.textContent = '${tJs("passwords.passphraseShort", lang)}'; return; }
        if (p1.value !== p2.value) { msg.textContent = '${tJs("passwords.passphraseMismatch", lang)}'; return; }
        var body = { passphrase: p1.value };
        guarded("/export", body, function(res) {
          p1.value = ""; p2.value = "";
          if (res.status !== 200) { msg.textContent = res.d.error || '${tJs("passwords.error", lang)}'; return; }
          msg.textContent = '${tJs("passwords.exportDone", lang)}'.split("{n}").join(String(res.d.count));
          if (typeof Blob === "function" && typeof URL !== "undefined" && URL.createObjectURL) {
            var a = document.createElement("a");
            a.href = URL.createObjectURL(new Blob([JSON.stringify(res.d)], { type: "application/json" }));
            a.download = "crow-keychain-" + new Date().toISOString().slice(0, 10) + ".json";
            document.body.appendChild(a); a.click(); a.remove();
          }
        });
      });

      document.getElementById("pw-import-go").addEventListener("click", function() {
        var input = document.getElementById("pw-import-file");
        var pass = document.getElementById("pw-import-pass");
        var msg = document.getElementById("pw-import-msg");
        var f = input.files && input.files[0];
        if (!f || !pass.value) { msg.textContent = '${tJs("passwords.importMissing", lang)}'; return; }
        f.text().then(function(text) {
          var file;
          try { file = JSON.parse(text); } catch (e) { msg.textContent = '${tJs("passwords.importBadFile", lang)}'; return; }
          var body = { file: file, passphrase: pass.value };
          guarded("/import", body, function(res) {
            pass.value = "";
            if (res.status !== 200) { msg.textContent = res.d.error || '${tJs("passwords.error", lang)}'; return; }
            msg.textContent = '${tJs("passwords.importDone", lang)}'.split("{imported}").join(String(res.d.imported)).split("{skipped}").join(String(res.d.skipped));
            setTimeout(function() { location.reload(); }, 1500);
          });
        });
      });

      fetch(API + "/activity").then(function(r) { return r.json(); }).then(function(d) {
        var ul = document.getElementById("pw-activity");
        var events = (d && d.events) || [];
        if (!events.length) { var li0 = document.createElement("li"); li0.textContent = '${tJs("passwords.activityEmpty", lang)}'; ul.appendChild(li0); return; }
        events.forEach(function(e) {
          var li = document.createElement("li");
          var what = EVENTS[e.event] || e.event;
          var label = (e.details && e.details.label) ? " — " + e.details.label : "";
          li.textContent = String(e.at || "") + " · " + what + label;
          ul.appendChild(li);
        });
      }).catch(function() {});
    })();
  </script>`;
}

export default {
  id: "passwords",
  group: "account",
  icon: ICON,
  labelKey: "settings.section.passwords",
  navOrder: 12, // after Change Password (10) and Two-Factor (11)

  async getPreview({ db, lang }) {
    try {
      const { listEntries } = await import("../../../keychain/store.js");
      return fill(t("passwords.preview", lang), { n: (await listEntries(db)).length });
    } catch {
      return "-";
    }
  },

  async render({ res, db, lang }) {
    const { listEntries } = await import("../../../keychain/store.js");
    const { loadKeychainKey } = await import("../../../keychain/key.js");
    const { vaultwardenStatus } = await import("../../../keychain/vault-save.js");
    const { defaultReauthGate } = await import("../../../keychain/api.js");
    // The page lists metadata only, but keep it out of the bfcache and HTTP caches anyway.
    try { res?.set?.("Cache-Control", "no-store"); } catch {}
    const entries = await listEntries(db, { keyId: loadKeychainKey()?.id || null });
    const vs = vaultwardenStatus();
    const method = await defaultReauthGate().method();
    return renderPasswordsPage({ entries, method, ...vaultState(vs), lang }) + passwordsClientJS(lang);
  },
};
