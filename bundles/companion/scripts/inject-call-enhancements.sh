#!/bin/bash
# Inject Crow Calls bundle enhancements into the companion frontend.
# Called from entrypoint.sh when the calls bundle is detected at /crow-bundles/calls/.
#
# This script:
# 1. Injects calls-bundle scripts (WebRTC + voice panel) from the read-only volume
# 2. Injects a bridge that disables companion's own WebRTC signaling (CrowCalls takes over)
# 3. Extends CrowCalls.validModes to include "avatar" and "both"
# 4. Adds an AI companion pill to the calls voice panel
# 5. Adds avatar mode placeholder badge support

CALLS_DIR="${1:-/crow-bundles/calls}"
FRONTEND_HTML="/app/frontend/index.html"
GATEWAY_URL="${CROW_GATEWAY_URL:-}"

if [ ! -f "$FRONTEND_HTML" ]; then
    echo "[call-enhancements] Frontend HTML not found, skipping."
    exit 0
fi

if grep -q "crow-call-enhancements" "$FRONTEND_HTML" 2>/dev/null; then
    echo "[call-enhancements] Already injected."
    exit 0
fi

# 1. Inject calls-bundle WebRTC module (standalone, own WS to /calls/ws)
if [ -f "$CALLS_DIR/scripts/crow-calls-webrtc.js" ]; then
    echo '<script id="crow-calls-webrtc">' >> "$FRONTEND_HTML"
    cat "$CALLS_DIR/scripts/crow-calls-webrtc.js" >> "$FRONTEND_HTML"
    echo '</script>' >> "$FRONTEND_HTML"
    echo "[call-enhancements] Injected calls-bundle WebRTC module."
fi

# 2. Inject calls-bundle voice panel (listens to CrowCalls events)
if [ -f "$CALLS_DIR/scripts/crow-calls-panel.js" ]; then
    echo '<script id="crow-calls-panel">' >> "$FRONTEND_HTML"
    cat "$CALLS_DIR/scripts/crow-calls-panel.js" >> "$FRONTEND_HTML"
    echo '</script>' >> "$FRONTEND_HTML"
    echo "[call-enhancements] Injected calls-bundle voice panel."
fi

# 3. Inject avatar sync module (Live2D state capture + DataChannel broadcast)
if [ -f "/app/scripts/crow-avatar-sync.js" ]; then
    echo '<script id="crow-avatar-sync">' >> "$FRONTEND_HTML"
    cat /app/scripts/crow-avatar-sync.js >> "$FRONTEND_HTML"
    echo '</script>' >> "$FRONTEND_HTML"
    echo "[call-enhancements] Injected avatar sync module."
fi

# 4. Inject remote avatar renderer (Live2D + fallback for peers)
if [ -f "/app/scripts/crow-remote-avatar.js" ]; then
    echo '<script id="crow-remote-avatar">' >> "$FRONTEND_HTML"
    cat /app/scripts/crow-remote-avatar.js >> "$FRONTEND_HTML"
    echo '</script>' >> "$FRONTEND_HTML"
    echo "[call-enhancements] Injected remote avatar renderer."
fi

# 5. Inject bridge + enhancement script
cat >> "$FRONTEND_HTML" << 'ENHANCESCRIPT'
<script id="crow-call-enhancements">
/**
 * Crow Companion + Calls Bundle Bridge
 *
 * When both CrowCalls (calls bundle) and CrowWS (OLV companion) are present:
 * - CrowCalls handles all peer call signaling via /calls/ws
 * - CrowWS continues handling WM sync, AI chat, notifications
 * - Companion's own CrowWebRTC yields signaling to calls bundle
 * - AI companion pill is added to the calls voice panel
 * - "avatar" and "both" representation modes are enabled
 */
(function() {
  "use strict";

  var BRIDGE_CHECK_INTERVAL = 200;
  var MAX_CHECKS = 50; // 10 seconds max

  var _aiSpeaking = false;
  var _bridged = false;

  function tryBridge() {
    var checks = 0;
    var timer = setInterval(function() {
      checks++;
      if (checks > MAX_CHECKS) {
        clearInterval(timer);
        return;
      }

      // Need both CrowCalls and CrowWS to bridge
      if (!window.CrowCalls) return;

      // Bridge: disable companion's own WebRTC signaling (CrowCalls takes over)
      if (!_bridged && window.CrowWebRTC) {
        window.CrowWebRTC._disabled = true;
        console.log("[call-enhancements] Companion WebRTC yielded to calls bundle.");
        _bridged = true;
      }

      // Extend valid representation modes to include avatar and both
      if (window.CrowCalls.validModes) {
        var modes = window.CrowCalls.validModes;
        if (modes.indexOf("avatar") === -1) modes.push("avatar");
        if (modes.indexOf("both") === -1) modes.push("both");
        console.log("[call-enhancements] Extended modes:", modes.join(", "));
      }

      // Add AI companion pill to calls voice panel when a call is active
      setupAiPill();

      // Listen for OLV TTS events to drive AI speaking state
      setupTtsListener();

      clearInterval(timer);
    }, BRIDGE_CHECK_INTERVAL);
  }

  // ─── AI Companion Pill ───
  // Injects a "Crow AI" pill into the calls voice panel (#crow-calls-panel)
  // so call participants can see the AI companion's speaking state.

  var _aiPillInjected = false;

  function setupAiPill() {
    if (_aiPillInjected) return;
    _aiPillInjected = true;

    var calls = window.CrowCalls;

    // When the group updates (call becomes active), inject AI pill
    calls.on("group-update", function(msg) {
      var members = msg.members || [];
      if (members.length < 2) return;

      // Wait a tick for the panel DOM to update
      setTimeout(function() {
        injectAiPill();
      }, 50);
    });

    // Also inject on ws-connected in case group-update already fired
    calls.on("ws-connected", function() {
      setTimeout(function() { injectAiPill(); }, 200);
    });
  }

  function injectAiPill() {
    var panel = document.getElementById("crow-calls-panel");
    if (!panel) return;
    if (panel.querySelector('[data-uid="ai"]')) return; // Already there

    var pill = document.createElement("div");
    pill.setAttribute("data-uid", "ai");
    pill.style.cssText = "display:flex;align-items:center;gap:8px;background:rgba(15,15,23,0.75);backdrop-filter:blur(8px);border-radius:26px;padding:4px 12px 4px 4px;border:1px solid rgba(61,61,77,0.4);transition:border-color 0.2s,box-shadow 0.2s;";

    var avatar = document.createElement("div");
    avatar.className = "vp-avatar";
    avatar.style.cssText = "width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;background:linear-gradient(135deg,#818cf8,#a78bfa);";
    avatar.textContent = "AI";

    var name = document.createElement("div");
    name.className = "vp-name";
    name.style.cssText = "font-size:11px;font-weight:600;color:#a8a29e;";
    name.textContent = "Crow";

    pill.appendChild(avatar);
    pill.appendChild(name);
    panel.insertBefore(pill, panel.firstChild);
  }

  function setAiSpeaking(speaking) {
    var panel = document.getElementById("crow-calls-panel");
    if (!panel) return;
    var el = panel.querySelector('[data-uid="ai"]');
    if (!el) return;
    if (speaking) {
      el.style.borderColor = "rgba(99,102,241,0.5)";
      el.style.boxShadow = "0 0 10px rgba(99,102,241,0.15)";
    } else {
      el.style.borderColor = "rgba(61,61,77,0.4)";
      el.style.boxShadow = "none";
    }
  }

  // ─── TTS Listener ───
  // Listen for OLV WebSocket events to detect when the AI is speaking.
  // These events come through CrowWS (companion's own WebSocket).

  var _ttsListenerSetup = false;

  function setupTtsListener() {
    if (_ttsListenerSetup) return;
    _ttsListenerSetup = true;

    window.CrowWS = window.CrowWS || { handlers: [] };
    if (!Array.isArray(window.CrowWS.handlers)) {
      window.CrowWS.handlers = [];
    }

    window.CrowWS.handlers.push(function(d) {
      if (d.type === "full-text" || d.type === "sentence") {
        _aiSpeaking = true;
        setAiSpeaking(true);
      }
      if (d.type === "frontend-playback-complete") {
        _aiSpeaking = false;
        setAiSpeaking(false);
      }
    });
  }

  // ─── Avatar Mode Placeholder ───
  // When a peer is in "avatar" mode, show a placeholder badge on their pill
  // instead of camera video. This gets upgraded to real Live2D in Phase 7.

  function setupAvatarPlaceholder() {
    if (!window.CrowCalls) return;

    window.CrowCalls.on("peer-representation", function(data) {
      if (data.mode === "avatar" || data.mode === "both") {
        showAvatarBadge(data.uid, data.mode);
      } else {
        removeAvatarBadge(data.uid);
      }
    });

    // Also handle local mode changes
    window.CrowCalls.on("representation-changed", function(data) {
      var myUid = window.CrowCalls.getMyUid();
      if (!myUid) return;
      if (data.mode === "avatar" || data.mode === "both") {
        showAvatarBadge(myUid, data.mode);
      } else {
        removeAvatarBadge(myUid);
      }
    });
  }

  function showAvatarBadge(uid, mode) {
    var panel = document.getElementById("crow-calls-panel");
    if (!panel) return;
    var pill = panel.querySelector('[data-uid="' + uid + '"]');
    if (!pill) return;

    // Don't add duplicate
    if (pill.querySelector(".vp-avatar-badge")) return;

    var badge = document.createElement("div");
    badge.className = "vp-avatar-badge";
    badge.style.cssText = "position:absolute;top:-4px;left:-4px;width:16px;height:16px;border-radius:50%;background:linear-gradient(135deg,#818cf8,#a78bfa);display:flex;align-items:center;justify-content:center;font-size:8px;color:#fff;border:2px solid rgba(15,15,23,0.9);";
    badge.textContent = mode === "both" ? "\u2B50" : "\u2728"; // star / sparkle
    badge.title = mode === "avatar" ? "Avatar mode" : "Camera + Avatar";
    pill.style.position = "relative";
    pill.appendChild(badge);
  }

  function removeAvatarBadge(uid) {
    var panel = document.getElementById("crow-calls-panel");
    if (!panel) return;
    var pill = panel.querySelector('[data-uid="' + uid + '"]');
    if (!pill) return;
    var badge = pill.querySelector(".vp-avatar-badge");
    if (badge) badge.remove();
  }

  // ─── Initialize ───
  tryBridge();

  // Avatar placeholder needs CrowCalls to be ready
  var avatarTimer = setInterval(function() {
    if (window.CrowCalls) {
      setupAvatarPlaceholder();

      // Start avatar sync (Live2D state capture + DataChannel broadcast)
      if (window.CrowAvatarSync) {
        window.CrowAvatarSync.start();
      }

      // Wire remote avatar renderer (Live2D instances for peers in avatar mode)
      if (window.CrowRemoteAvatar) {
        window.CrowRemoteAvatar.wireEvents();
      }

      clearInterval(avatarTimer);
    }
  }, 300);
  setTimeout(function() { clearInterval(avatarTimer); }, 15000);

  // Clean up avatar sync on disconnect
  var disconnectWatcher = setInterval(function() {
    if (window.CrowCalls) {
      window.CrowCalls.on("disconnected", function() {
        if (window.CrowAvatarSync) window.CrowAvatarSync.stop();
        if (window.CrowRemoteAvatar) window.CrowRemoteAvatar.destroyAll();
      });
      clearInterval(disconnectWatcher);
    }
  }, 500);
  setTimeout(function() { clearInterval(disconnectWatcher); }, 15000);

})();
</script>
ENHANCESCRIPT

echo "[call-enhancements] Injected bridge + enhancement script."
