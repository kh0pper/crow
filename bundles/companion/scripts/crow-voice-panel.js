(function() {
  "use strict";

  var SPEAK_THRESHOLD = 15;
  var FRAME_SKIP = 6; // ~10fps at 60fps rAF

  var _stack = null;
  var _visible = false;
  var _frameCount = 0;
  var _audioCtx = null;
  var _analysers = {}; // uid → { source, analyser, data }
  var _peerProfiles = {}; // uid → { name, color }
  var _aiSpeaking = false;
  var _mutedPeers = {}; // uid → true

  var _profile = window.CrowProfile || { name: "User", color: "#818cf8" };
  var _defaultColors = ["#f472b6", "#60a5fa", "#fb923c", "#34d399", "#a78bfa"];

  function getInitial(name) { return name ? name.charAt(0).toUpperCase() : "?"; }

  // ─── AudioContext (deferred until user gesture) ───
  function ensureAudioCtx() {
    if (_audioCtx) return _audioCtx;
    try {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (_audioCtx.state === "suspended") {
        var resume = function() {
          _audioCtx.resume();
          document.removeEventListener("click", resume);
          document.removeEventListener("touchstart", resume);
        };
        document.addEventListener("click", resume);
        document.addEventListener("touchstart", resume);
      }
    } catch(e) {
      console.warn("[crow-voice-panel] AudioContext unavailable:", e);
    }
    return _audioCtx;
  }

  function createAnalyser(uid, stream) {
    if (_analysers[uid] || !stream) return;
    var ctx = ensureAudioCtx();
    if (!ctx) return;
    try {
      var source = ctx.createMediaStreamSource(stream);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      _analysers[uid] = { source: source, analyser: analyser, data: new Uint8Array(analyser.frequencyBinCount) };
    } catch(e) {
      console.warn("[crow-voice-panel] analyser failed for", uid, e);
    }
  }

  function cleanupAnalyser(uid) {
    var a = _analysers[uid];
    if (!a) return;
    try { a.source.disconnect(); } catch(e) {}
    delete _analysers[uid];
  }

  function getAudioLevel(uid) {
    var a = _analysers[uid];
    if (!a || !_audioCtx || _audioCtx.state !== "running") return 0;
    a.analyser.getByteFrequencyData(a.data);
    var sum = 0;
    for (var i = 0; i < a.data.length; i++) sum += a.data[i];
    return sum / a.data.length;
  }

  // ─── DOM: Bottom-Left Stack ───
  function createStack() {
    _stack = document.createElement("div");
    _stack.id = "crow-voice-stack";
    _stack.style.cssText = "position:fixed;top:12px;right:120px;z-index:499;display:flex;flex-direction:row;gap:6px;opacity:0;transition:opacity 0.2s ease;pointer-events:none;font-family:'DM Sans',system-ui,sans-serif;";
    document.body.appendChild(_stack);
  }

  function showStack() {
    if (_visible) return;
    if (!_stack) createStack();
    _visible = true;
    _stack.style.opacity = "1";
    _stack.style.pointerEvents = "auto";
  }

  function hideStack() {
    if (!_visible) return;
    _visible = false;
    if (_stack) {
      _stack.style.opacity = "0";
      _stack.style.pointerEvents = "none";
    }
    var uids = Object.keys(_analysers);
    for (var i = 0; i < uids.length; i++) cleanupAnalyser(uids[i]);
    _peerProfiles = {};
    _mutedPeers = {};
  }

  // ─── Peer pills ───
  function getPeerEntry(uid) {
    if (!_stack) return null;
    return _stack.querySelector('[data-uid="' + uid + '"]');
  }

  function addPeerEntry(uid) {
    if (getPeerEntry(uid)) return;
    var profile = _peerProfiles[uid] || { name: "...", color: _defaultColors[Object.keys(_peerProfiles).length % _defaultColors.length] };

    var pill = document.createElement("div");
    pill.setAttribute("data-uid", uid);
    pill.style.cssText = "display:flex;align-items:center;gap:8px;background:rgba(15,15,23,0.75);backdrop-filter:blur(8px);border-radius:26px;padding:4px 12px 4px 4px;border:1px solid rgba(61,61,77,0.4);transition:border-color 0.2s,box-shadow 0.2s;";

    var avatar = document.createElement("div");
    avatar.className = "vp-avatar";
    avatar.style.cssText = "width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,0.3);flex-shrink:0;background:" + profile.color + ";";
    avatar.textContent = getInitial(profile.name);

    var name = document.createElement("div");
    name.className = "vp-name";
    name.style.cssText = "font-size:11px;font-weight:600;color:#e7e5e4;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    name.textContent = profile.name;

    pill.appendChild(avatar);
    pill.appendChild(name);
    _stack.appendChild(pill);
  }

  function removePeerEntry(uid) {
    var el = getPeerEntry(uid);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    cleanupAnalyser(uid);
    delete _peerProfiles[uid];
    delete _mutedPeers[uid];
  }

  function updatePeerEntry(uid, profile) {
    var el = getPeerEntry(uid);
    if (!el) { addPeerEntry(uid); el = getPeerEntry(uid); }
    if (!el) return;
    var avatar = el.querySelector(".vp-avatar");
    var name = el.querySelector(".vp-name");
    if (avatar) {
      avatar.style.background = profile.color;
      avatar.textContent = getInitial(profile.name);
    }
    if (name) name.textContent = profile.name;
  }

  function setSpeaking(uid, speaking) {
    var el = getPeerEntry(uid);
    if (!el) return;
    if (speaking && !_mutedPeers[uid]) {
      el.style.borderColor = "rgba(34,197,94,0.5)";
      el.style.boxShadow = "0 0 10px rgba(34,197,94,0.15)";
    } else {
      el.style.borderColor = "rgba(61,61,77,0.4)";
      el.style.boxShadow = "none";
    }
  }

  function setAiSpeaking(speaking) {
    var el = _stack ? _stack.querySelector('[data-uid="ai"]') : null;
    if (!el) return;
    if (speaking) {
      el.style.borderColor = "rgba(99,102,241,0.5)";
      el.style.boxShadow = "0 0 10px rgba(99,102,241,0.15)";
    } else {
      el.style.borderColor = "rgba(61,61,77,0.4)";
      el.style.boxShadow = "none";
    }
  }

  // ─── Speaking detection loop ───
  function speakingLoop() {
    requestAnimationFrame(speakingLoop);
    if (!_visible) return;
    _frameCount++;
    if (_frameCount % FRAME_SKIP !== 0) return;

    var webrtc = window.CrowWebRTC || {};

    var peerUids = webrtc.getPeerUids ? webrtc.getPeerUids() : [];
    for (var i = 0; i < peerUids.length; i++) {
      var uid = peerUids[i];
      if (!_analysers[uid]) {
        var stream = webrtc.getPeerStream ? webrtc.getPeerStream(uid) : null;
        if (stream) createAnalyser(uid, stream);
      }
      setSpeaking(uid, getAudioLevel(uid) > SPEAK_THRESHOLD);
    }

    var myUid = webrtc.getMyUid ? webrtc.getMyUid() : null;
    if (myUid) {
      if (!_analysers[myUid]) {
        var localStream = webrtc.getLocalStream ? webrtc.getLocalStream() : null;
        if (localStream) createAnalyser(myUid, localStream);
      }
      setSpeaking(myUid, getAudioLevel(myUid) > SPEAK_THRESHOLD);
    }

    setAiSpeaking(_aiSpeaking);
  }

  // ─── Broadcast own profile ───
  function broadcastProfile() {
    if (!window.CrowWS || !window.CrowWS._activeSocket) return;
    try {
      window.CrowWS._activeSocket.send(JSON.stringify({
        type: "peer-profile",
        name: _profile.name,
        color: _profile.color,
      }));
    } catch(e) {}
  }

  // ─── Group update handler ───
  function onGroupUpdate(members, myUid) {
    if (members.length < 2) {
      hideStack();
      return;
    }

    showStack();

    // Add AI entry if missing
    if (!getPeerEntry("ai")) {
      _peerProfiles["ai"] = { name: "Crow", color: "#818cf8" };
      var aiPill = document.createElement("div");
      aiPill.setAttribute("data-uid", "ai");
      aiPill.style.cssText = "display:flex;align-items:center;gap:8px;background:rgba(15,15,23,0.75);backdrop-filter:blur(8px);border-radius:26px;padding:4px 12px 4px 4px;border:1px solid rgba(61,61,77,0.4);transition:border-color 0.2s,box-shadow 0.2s;";
      var aiAvatar = document.createElement("div");
      aiAvatar.className = "vp-avatar";
      aiAvatar.style.cssText = "width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;background:linear-gradient(135deg,#818cf8,#a78bfa);";
      aiAvatar.textContent = "AI";
      var aiName = document.createElement("div");
      aiName.className = "vp-name";
      aiName.style.cssText = "font-size:11px;font-weight:600;color:#a8a29e;";
      aiName.textContent = "Crow";
      aiPill.appendChild(aiAvatar);
      aiPill.appendChild(aiName);
      _stack.insertBefore(aiPill, _stack.firstChild);
    }

    var currentUids = {};
    for (var i = 0; i < members.length; i++) {
      var uid = members[i];
      if (uid === myUid) {
        if (!getPeerEntry(uid)) {
          _peerProfiles[uid] = { name: _profile.name + " (you)", color: _profile.color };
          addPeerEntry(uid);
        }
      } else {
        if (!getPeerEntry(uid)) addPeerEntry(uid);
      }
      currentUids[uid] = true;
    }
    currentUids["ai"] = true; // Don't remove AI entry

    // Remove departed
    var entries = _stack.querySelectorAll("[data-uid]");
    for (var i = 0; i < entries.length; i++) {
      var uid = entries[i].getAttribute("data-uid");
      if (!currentUids[uid]) removePeerEntry(uid);
    }

    broadcastProfile();
  }

  // ─── Initialize ───
  // No DOM changes at page load. Stack created on first group join.
  requestAnimationFrame(speakingLoop);

  window.CrowWS = window.CrowWS || { handlers: [] };
  window.CrowWS.handlers.push(function(d) {
    // When calls bundle is active, its own panel handles peer display
    if (window.CrowWebRTC && window.CrowWebRTC._disabled) return;

    if (d.type === "group-update" && d.members) {
      onGroupUpdate(d.members, d.your_uid);
    }

    if (d.type === "peer-profile" && d.from_uid) {
      _peerProfiles[d.from_uid] = { name: d.name || "User", color: d.color || _defaultColors[0] };
      updatePeerEntry(d.from_uid, _peerProfiles[d.from_uid]);
    }

    if (d.type === "webrtc-mute" && d.from_uid) {
      _mutedPeers[d.from_uid] = !!d.muted;
    }

    if (d.type === "full-text" || d.type === "sentence") {
      _aiSpeaking = true;
    }
    if (d.type === "frontend-playback-complete") {
      _aiSpeaking = false;
    }
  });

})();
