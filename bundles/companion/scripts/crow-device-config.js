/**
 * Crow Companion — per-device kiosk config (Part 3)
 *
 * When the companion is opened as a bound kiosk (URL carries ?device=<id>), this
 * fetches that device's config from the gateway and applies it:
 *   - selects the bound bot's OLVV character preset (persona + avatar), and
 *   - toggles companion_features (social/chat UI, pet/idle, animation).
 *
 * The fast->escalate model pair is GLOBAL (the gateway /llm/v1 router), so this
 * never touches the LLM config — only presentation.
 *
 * VERIFY-ON-DEVICE notes (built per the OLVV patterns; confirm on a real kiosk):
 *   - the exact "switch-config" message type/field for this OLVV build, and
 *   - which DOM nodes the social/animation toggles should hide.
 * Everything is defensive (try/catch, polling) so a mismatch degrades to "no-op",
 * never a crash.
 */
(function () {
  "use strict";

  function param(n) {
    try { return new URLSearchParams(location.search).get(n); } catch (e) { return null; }
  }

  // Device identity: ?device= wins; otherwise a previously-configured kiosk id.
  var deviceId = param("device") || "";
  try {
    if (deviceId) localStorage.setItem("crow_kiosk_device", deviceId);
    else deviceId = localStorage.getItem("crow_kiosk_device") || "";
  } catch (e) {}
  if (!deviceId) return; // not a bound kiosk — leave default companion behavior

  function applyFeatures(f) {
    if (!f) return;
    window.CrowDeviceFeatures = f;
    // Reflect toggles as attributes so injected panels / CSS can react.
    var root = document.documentElement;
    root.setAttribute("data-crow-social", f.social_chat ? "on" : "off");
    root.setAttribute("data-crow-pet", f.pet_mode ? "on" : "off");
    root.setAttribute("data-crow-anim", f.avatar_animation === false ? "off" : "on");
    root.setAttribute("data-crow-face", f.face_tracking === false ? "off" : "on");
    // Hide the face-tracking toggle button entirely on disabled devices, and
    // stop tracking if the flag arrives after the user already started it
    // (features load via async fetch — a click can beat the response).
    try {
      var ft = window.CrowFaceTracking;
      if (f.face_tracking === false && ft) {
        if (ft.isEnabled && ft.isEnabled()) ft.toggle();
      }
    } catch (e) {}
    // Social/chatroom UI: the Crow voice/peer panel is the social surface.
    var social = document.getElementById("crow-voice-panel");
    if (social) social.style.display = f.social_chat ? "" : "none";
  }

  function switchPreset(preset) {
    if (!preset) return;
    var sent = false;
    function trySend() {
      try {
        var s = window.CrowWS && window.CrowWS._activeSocket;
        if (s && s.readyState === 1) {
          // OLVV character/config switch. Field name verified-on-device.
          s.send(JSON.stringify({ type: "switch-config", file: preset }));
          sent = true;
          return true;
        }
      } catch (e) {}
      return false;
    }
    if (!trySend()) {
      var n = 0;
      var iv = setInterval(function () {
        if (trySend() || ++n > 40) clearInterval(iv); // up to ~20s for the WS
      }, 500);
    }
  }

  function load() {
    // Relative to the companion origin. Works when the companion is served via
    // the gateway proxy (/companion/*), where /companion/device-config is handled
    // by the gateway (registered before the proxy). See companion-proxy.js.
    fetch("/companion/device-config?device=" + encodeURIComponent(deviceId), { credentials: "include" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        if (!cfg) return;
        window.CrowDeviceConfig = cfg;
        applyFeatures(cfg.companion_features);
        switchPreset(cfg.character_preset);
      })
      .catch(function () {});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load);
  else load();
})();
