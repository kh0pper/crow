/**
 * Settings Section: Notifications
 *
 * Manages notification type preferences AND push notification subscriptions.
 * Push works in any context: web browser, PWA, or Android WebView app.
 */

import { escapeHtml } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";
import { upsertSetting } from "../registry.js";
import { getVapidPublicKey } from "../../../push/web-push.js";

export default {
  id: "notifications",
  group: "general",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
  labelKey: "settings.section.notifications",
  navOrder: 30,

  async getPreview({ settings, lang }) {
    let prefs = { types_enabled: ["reminder", "media", "peer", "system"] };
    try {
      if (settings.notification_prefs) prefs = JSON.parse(settings.notification_prefs);
    } catch {}
    const enabled = prefs.types_enabled?.length || 0;
    return `${enabled} of 4 enabled`;
  },

  async render({ req, db, lang }) {
    let notifPrefs = { types_enabled: ["reminder", "media", "peer", "system"] };
    try {
      const { rows } = await db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'notification_prefs'",
        args: [],
      });
      if (rows.length > 0) notifPrefs = JSON.parse(rows[0].value);
    } catch {}

    const notifTypes = [
      { key: "reminder", label: t("settings.notifReminder", lang) },
      { key: "media", label: t("settings.notifMedia", lang) },
      { key: "peer", label: t("settings.notifPeer", lang) },
      { key: "system", label: t("settings.notifSystem", lang) },
    ];

    const checkboxes = notifTypes.map(({ key, label }) => {
      const checked = notifPrefs.types_enabled?.includes(key) ? "checked" : "";
      return `<label style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;cursor:pointer">
        <input type="checkbox" name="type_${key}" value="1" ${checked} style="accent-color:var(--crow-accent)"> ${escapeHtml(label)}
      </label>`;
    }).join("");

    // Push subscription count
    let pushCount = 0;
    try {
      const { rows } = await db.execute("SELECT COUNT(*) as cnt FROM push_subscriptions");
      pushCount = rows[0]?.cnt || 0;
    } catch {}

    const vapidKey = getVapidPublicKey();
    const pushAvailable = !!vapidKey;

    // Push subscription UI
    const pushSection = pushAvailable
      ? `<div style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--crow-border)">
        <h4 style="margin:0 0 0.5rem 0;font-size:0.95rem">Push Notifications</h4>
        <p style="color:var(--crow-text-muted);font-size:0.85rem;margin-bottom:0.75rem">
          Receive push notifications on this device. Works in browsers, as a PWA, and in the Android app.
        </p>
        <div id="push-status" style="margin-bottom:0.75rem"></div>
        <button id="push-toggle-btn" onclick="togglePushSubscription()" class="btn btn-primary" style="display:none">
          Enable Push
        </button>
        <p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.5rem">
          ${pushCount} device${pushCount !== 1 ? "s" : ""} registered
        </p>
      </div>`
      : `<div style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--crow-border)">
        <h4 style="margin:0 0 0.5rem 0;font-size:0.95rem">Push Notifications</h4>
        <p style="color:var(--crow-text-muted);font-size:0.85rem">
          Not configured. Add VAPID keys to .env. Generate with:
          <code style="background:var(--crow-bg-elevated);padding:0.1rem 0.3rem;border-radius:3px">npx web-push generate-vapid-keys</code>
        </p>
      </div>`;

    // Client-side JS for push management (uses DOM API, no innerHTML with user data)
    const pushJs = pushAvailable
      ? `<script>
    (function() {
      var VAPID_KEY = '${escapeHtml(vapidKey)}';
      var statusEl = document.getElementById('push-status');
      var btnEl = document.getElementById('push-toggle-btn');
      var isSubscribed = false;

      function urlB64ToUint8(b64) {
        var p = '='.repeat((4 - b64.length % 4) % 4);
        var raw = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/'));
        var arr = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        return arr;
      }

      function platform() {
        if (navigator.userAgent.indexOf('CrowAndroid') !== -1) return 'android';
        if (window.matchMedia('(display-mode: standalone)').matches) return 'pwa';
        return 'web';
      }

      function setStatus(text, color) {
        statusEl.textContent = '';
        var span = document.createElement('span');
        span.style.cssText = 'font-size:0.85rem;color:' + (color || 'var(--crow-text-muted)');
        span.textContent = text;
        statusEl.appendChild(span);
      }

      function arrayToBase64Url(buffer) {
        var bytes = new Uint8Array(buffer);
        var str = '';
        for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
        return btoa(str).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      }

      function updateUI() {
        if (isSubscribed) {
          var p = platform();
          var label = p === 'android' ? 'Android app' : p === 'pwa' ? 'PWA' : 'browser';
          setStatus('\\u2713 Push enabled on this ' + label, 'var(--crow-accent)');
          btnEl.textContent = 'Disable Push';
          btnEl.className = 'btn';
        } else {
          setStatus('Push notifications are off for this device.');
          btnEl.textContent = 'Enable Push';
          btnEl.className = 'btn btn-primary';
        }
        btnEl.style.display = '';
      }

      async function check() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
          setStatus('Push notifications are not supported in this browser.');
          return;
        }
        try {
          var reg = await navigator.serviceWorker.ready;
          var sub = await reg.pushManager.getSubscription();
          isSubscribed = !!sub;
          updateUI();
        } catch (err) {
          setStatus('Error: ' + err.message, '#e74c3c');
        }
      }

      window.togglePushSubscription = async function() {
        btnEl.disabled = true;
        btnEl.textContent = 'Working...';
        try {
          var reg = await navigator.serviceWorker.ready;
          if (isSubscribed) {
            var sub = await reg.pushManager.getSubscription();
            if (sub) {
              await fetch('/api/push/register', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: sub.endpoint })
              });
              await sub.unsubscribe();
            }
            isSubscribed = false;
          } else {
            var perm = await Notification.requestPermission();
            if (perm !== 'granted') {
              setStatus('Notification permission denied. Check your browser or device settings.', '#e74c3c');
              btnEl.disabled = false;
              btnEl.textContent = 'Enable Push';
              return;
            }
            var sub = await reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlB64ToUint8(VAPID_KEY)
            });
            await fetch('/api/push/register', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                endpoint: sub.endpoint,
                keys: {
                  p256dh: arrayToBase64Url(sub.getKey('p256dh')),
                  auth: arrayToBase64Url(sub.getKey('auth'))
                },
                platform: platform(),
                deviceName: navigator.userAgent.substring(0, 100)
              })
            });
            isSubscribed = true;
          }
          updateUI();
        } catch (err) {
          setStatus('Error: ' + err.message, '#e74c3c');
        } finally {
          btnEl.disabled = false;
        }
      };

      check();
    })();
    </script>`
      : "";

    return `<form method="POST" action="/dashboard/settings">
      <input type="hidden" name="_csrf" value="${req.csrfToken}" />
      <input type="hidden" name="action" value="save_notification_prefs" />
      <p style="color:var(--crow-text-muted);font-size:0.85rem;margin-bottom:0.75rem">${t("settings.notifTypes", lang)}</p>
      ${checkboxes}
      <button type="submit" class="btn btn-primary" style="margin-top:0.5rem">${t("common.save", lang)}</button>
    </form>
    ${pushSection}
    ${pushJs}`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "save_notification_prefs") return false;

    const typesEnabled = [];
    if (req.body.type_reminder) typesEnabled.push("reminder");
    if (req.body.type_media) typesEnabled.push("media");
    if (req.body.type_peer) typesEnabled.push("peer");
    if (req.body.type_system) typesEnabled.push("system");
    const prefs = JSON.stringify({ types_enabled: typesEnabled });
    await upsertSetting(db, "notification_prefs", prefs);
    res.redirect("/dashboard/settings?section=notifications");
    return true;
  },
};
