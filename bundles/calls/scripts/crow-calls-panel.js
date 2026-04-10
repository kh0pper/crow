/**
 * Crow Calls — Standalone Voice Panel
 *
 * Displays peer pills with speaking indicators. Listens to
 * window.CrowCalls events (not CrowWS). No AI companion pill
 * in standalone mode (companion adds it via enhancement layer).
 */
(function() {
  "use strict";

  var SPEAK_THRESHOLD = 15;
  var FRAME_SKIP = 6; // ~10fps at 60fps rAF

  var _stack = null;
  var _visible = false;
  var _frameCount = 0;
  var _audioCtx = null;
  var _analysers = {};      // uid → { source, analyser, data }
  var _peerProfiles = {};   // uid → { name, color }
  var _mutedPeers = {};     // uid → true
  var _videoStates = {};    // uid → true/false
  var _repModes = {};       // uid → mode string
  var _myUid = null;

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
      console.warn("[crow-calls-panel] AudioContext unavailable:", e);
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
    } catch(e) {}
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

  // ─── DOM: Top-Right Horizontal Stack ───
  function createStack() {
    _stack = document.createElement("div");
    _stack.id = "crow-calls-panel";
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
    _videoStates = {};
    _repModes = {};
  }

  // ─── Peer pills ───
  function getPeerEntry(uid) {
    if (!_stack) return null;
    return _stack.querySelector('[data-uid="' + uid + '"]');
  }

  function addPeerEntry(uid) {
    if (getPeerEntry(uid)) return;
    var profile = _peerProfiles[uid] || {
      name: "...",
      color: _defaultColors[Object.keys(_peerProfiles).length % _defaultColors.length],
    };

    var pill = document.createElement("div");
    pill.setAttribute("data-uid", uid);
    pill.style.cssText = "display:flex;align-items:center;gap:8px;background:rgba(15,15,23,0.75);backdrop-filter:blur(8px);border-radius:26px;padding:4px 12px 4px 4px;border:1px solid rgba(61,61,77,0.4);transition:border-color 0.2s,box-shadow 0.2s;position:relative;";

    // Avatar circle (shown when no video)
    var avatar = document.createElement("div");
    avatar.className = "vp-avatar";
    avatar.style.cssText = "width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,0.3);flex-shrink:0;background:" + profile.color + ";";
    avatar.textContent = getInitial(profile.name);

    // Video thumbnail (hidden by default, shown when camera on)
    var videoThumb = document.createElement("video");
    videoThumb.className = "vp-video";
    videoThumb.autoplay = true;
    videoThumb.playsInline = true;
    videoThumb.muted = true;
    var isMe = (uid === _myUid);
    videoThumb.style.cssText = "width:48px;height:32px;border-radius:8px;object-fit:cover;flex-shrink:0;display:none;" + (isMe ? "transform:scaleX(-1);" : "");

    // Mode indicator (small icon: mic or camera)
    var modeIcon = document.createElement("div");
    modeIcon.className = "vp-mode";
    modeIcon.style.cssText = "position:absolute;bottom:-2px;right:-2px;width:14px;height:14px;border-radius:50%;background:rgba(15,15,23,0.9);display:flex;align-items:center;justify-content:center;font-size:8px;color:#a8a29e;display:none;";

    var name = document.createElement("div");
    name.className = "vp-name";
    name.style.cssText = "font-size:11px;font-weight:600;color:#e7e5e4;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    name.textContent = profile.name;

    pill.appendChild(avatar);
    pill.appendChild(videoThumb);
    pill.appendChild(name);
    pill.appendChild(modeIcon);
    _stack.appendChild(pill);
  }

  function removePeerEntry(uid) {
    var el = getPeerEntry(uid);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    cleanupAnalyser(uid);
    delete _peerProfiles[uid];
    delete _mutedPeers[uid];
    delete _videoStates[uid];
    delete _repModes[uid];
  }

  /**
   * Show or hide the video thumbnail for a peer pill.
   */
  function updatePeerVideo(uid) {
    var el = getPeerEntry(uid);
    if (!el) return;
    var avatar = el.querySelector(".vp-avatar");
    var videoThumb = el.querySelector(".vp-video");
    if (!avatar || !videoThumb) return;

    var showVideo = !!_videoStates[uid];
    if (showVideo && window.CrowCalls) {
      var isMe = (uid === _myUid);
      var videoSrc = null;
      if (isMe) {
        videoSrc = window.CrowCalls.getLocalVideoStream();
      } else {
        var peerVideoEl = window.CrowCalls.getPeerVideoEl(uid);
        videoSrc = peerVideoEl ? peerVideoEl.srcObject : null;
      }
      if (videoSrc) {
        videoThumb.srcObject = videoSrc;
        videoThumb.style.display = "block";
        avatar.style.display = "none";
      }
    } else {
      videoThumb.style.display = "none";
      videoThumb.srcObject = null;
      avatar.style.display = "flex";
    }
  }

  /**
   * Update mode indicator icon on a peer pill.
   */
  function updateModeIndicator(uid) {
    var el = getPeerEntry(uid);
    if (!el) return;
    var modeIcon = el.querySelector(".vp-mode");
    if (!modeIcon) return;
    var mode = _repModes[uid] || "audio";
    if (mode === "camera" || mode === "both") {
      modeIcon.textContent = "\uD83C\uDFA5"; // camera emoji
      modeIcon.style.display = "flex";
    } else if (mode === "avatar") {
      modeIcon.textContent = "\uD83D\uDE42"; // avatar emoji
      modeIcon.style.display = "flex";
    } else {
      modeIcon.style.display = "none";
    }
  }

  function updatePeerEntry(uid, profile) {
    var el = getPeerEntry(uid);
    if (!el) { addPeerEntry(uid); el = getPeerEntry(uid); }
    if (!el) return;
    var avatar = el.querySelector(".vp-avatar");
    var nameEl = el.querySelector(".vp-name");
    if (avatar) {
      avatar.style.background = profile.color;
      avatar.textContent = getInitial(profile.name);
    }
    if (nameEl) nameEl.textContent = profile.name;
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

  // ─── Speaking detection loop ───
  function speakingLoop() {
    requestAnimationFrame(speakingLoop);
    if (!_visible || !window.CrowCalls) return;
    _frameCount++;
    if (_frameCount % FRAME_SKIP !== 0) return;

    var calls = window.CrowCalls;

    var peerUids = calls.getPeerUids();
    for (var i = 0; i < peerUids.length; i++) {
      var uid = peerUids[i];
      if (!_analysers[uid]) {
        var stream = calls.getPeerStream(uid);
        if (stream) createAnalyser(uid, stream);
      }
      setSpeaking(uid, getAudioLevel(uid) > SPEAK_THRESHOLD);
    }

    var myUid = calls.getMyUid();
    if (myUid) {
      if (!_analysers[myUid]) {
        var localStream = calls.getLocalStream();
        if (localStream) createAnalyser(myUid, localStream);
      }
      setSpeaking(myUid, getAudioLevel(myUid) > SPEAK_THRESHOLD);
    }
  }

  // ─── Event handlers (CrowCalls events, not CrowWS) ───

  function onGroupUpdate(msg) {
    var members = msg.members || [];
    if (members.length < 2) {
      hideStack();
      return;
    }

    showStack();

    var calls = window.CrowCalls;
    _myUid = calls ? calls.getMyUid() : null;

    var currentUids = {};
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      var uid = m.uid || m;
      var memberName = m.name || (_peerProfiles[uid] ? _peerProfiles[uid].name : "User");
      var memberColor = m.color || (_peerProfiles[uid] ? _peerProfiles[uid].color : _defaultColors[i % _defaultColors.length]);

      if (uid === _myUid) {
        memberName = (memberName || "You") + " (you)";
      }

      _peerProfiles[uid] = { name: memberName, color: memberColor };

      if (!getPeerEntry(uid)) {
        addPeerEntry(uid);
      } else {
        updatePeerEntry(uid, _peerProfiles[uid]);
      }
      currentUids[uid] = true;
    }

    // Remove departed peers
    if (_stack) {
      var entries = _stack.querySelectorAll("[data-uid]");
      for (var i = 0; i < entries.length; i++) {
        var uid = entries[i].getAttribute("data-uid");
        if (!currentUids[uid]) removePeerEntry(uid);
      }
    }

    // Broadcast our profile to the relay
    if (calls && window.CrowCallConfig) {
      calls.send({
        type: "peer-profile",
        name: window.CrowCallConfig.userName || "User",
        color: window.CrowCallConfig.userColor || _defaultColors[0],
      });
    }
  }

  function onPeerProfile(data) {
    var uid = data.uid;
    var profile = { name: data.name || "User", color: data.color || _defaultColors[0] };
    _peerProfiles[uid] = profile;
    updatePeerEntry(uid, profile);
  }

  function onPeerMute(data) {
    _mutedPeers[data.uid] = !!data.muted;
  }

  function onPeerVideoState(data) {
    _videoStates[data.uid] = !!data.videoEnabled;
    updatePeerVideo(data.uid);
  }

  function onPeerRepresentation(data) {
    _repModes[data.uid] = data.mode;
    updateModeIndicator(data.uid);
  }

  function onVideoChanged(data) {
    // Local user toggled video
    if (_myUid) {
      _videoStates[_myUid] = !!data.videoEnabled;
      updatePeerVideo(_myUid);
    }
  }

  function onRepresentationChanged(data) {
    if (_myUid) {
      _repModes[_myUid] = data.mode;
      updateModeIndicator(_myUid);
    }
  }

  // ─── Register event handlers when CrowCalls is available ───
  function registerHandlers() {
    if (!window.CrowCalls) {
      setTimeout(registerHandlers, 100);
      return;
    }

    var calls = window.CrowCalls;
    calls.on("group-update", onGroupUpdate);
    calls.on("peer-profile", onPeerProfile);
    calls.on("peer-mute", onPeerMute);
    calls.on("peer-video-state", onPeerVideoState);
    calls.on("peer-representation", onPeerRepresentation);
    calls.on("video-changed", onVideoChanged);
    calls.on("representation-changed", onRepresentationChanged);
    calls.on("peer-video-track", function(data) {
      // When a remote video track arrives, update the video display
      updatePeerVideo(data.uid);
    });
    calls.on("disconnected", function() { hideStack(); });
  }

  // ─── Initialize ───
  requestAnimationFrame(speakingLoop);
  registerHandlers();

})();
