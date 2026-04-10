/**
 * Crow Calls — Standalone Call Page UI
 *
 * Full-page call experience with:
 * - Pre-call screen (mic test, join button)
 * - In-call peer grid (adapts to peer count)
 * - Control bar (mic, hang up)
 *
 * Depends on window.CrowCalls (crow-calls-webrtc.js).
 * Renders into #crow-call-root.
 */
(function() {
  "use strict";

  var _root = null;
  var _state = "pre-call"; // "pre-call" | "in-call" | "ended"
  var _peerProfiles = {};
  var _mutedPeers = {};
  var _peerVideoStates = {};  // uid → true/false
  var _localAnalyser = null;
  var _audioCtx = null;
  var _peerGrid = null;
  var _controlBar = null;
  var _precallCameraStream = null;

  var VIDEO_PREVIEW_CONSTRAINTS = {
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 15, max: 20 },
  };

  // ─── Styles ───
  var CSS = [
    ".cc-precall { display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:24px;padding:24px; }",
    ".cc-room-info { text-align:center; }",
    ".cc-room-info h2 { font-size:18px;font-weight:600;color:#e7e5e4;margin-bottom:8px; }",
    ".cc-room-info p { font-size:13px;color:#78716c; }",
    ".cc-mic-test { display:flex;align-items:center;gap:12px;padding:16px 24px;background:rgba(26,26,46,0.5);border-radius:12px;border:1px solid rgba(61,61,77,0.4); }",
    ".cc-mic-test svg { flex-shrink:0; }",
    ".cc-mic-level { width:120px;height:6px;border-radius:3px;background:rgba(61,61,77,0.4);overflow:hidden; }",
    ".cc-mic-level-fill { height:100%;width:0%;border-radius:3px;background:#22c55e;transition:width 0.1s; }",
    ".cc-join-btn { padding:14px 40px;font-size:15px;font-weight:600;color:#fff;background:#22c55e;border:none;border-radius:12px;cursor:pointer;transition:background 0.15s; }",
    ".cc-join-btn:hover { background:#16a34a; }",
    ".cc-incall { display:flex;flex-direction:column;height:100%; }",
    ".cc-peer-grid { flex:1;display:grid;gap:8px;padding:8px;align-content:center; }",
    ".cc-peer-tile { background:rgba(26,26,46,0.5);border-radius:12px;border:1px solid rgba(61,61,77,0.4);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:120px;transition:border-color 0.2s,box-shadow 0.2s; }",
    ".cc-peer-tile.speaking { border-color:rgba(34,197,94,0.5);box-shadow:0 0 16px rgba(34,197,94,0.1); }",
    ".cc-peer-tile.muted-peer { opacity:0.7; }",
    ".cc-peer-avatar { width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.3); }",
    ".cc-peer-video { width:100%;height:100%;object-fit:cover;border-radius:12px;position:absolute;top:0;left:0; }",
    ".cc-peer-video.self-view { transform:scaleX(-1); }",
    ".cc-peer-tile { position:relative;overflow:hidden; }",
    ".cc-peer-overlay { position:absolute;bottom:8px;left:8px;right:8px;display:flex;align-items:center;justify-content:space-between;z-index:1; }",
    ".cc-peer-name { font-size:13px;font-weight:600;color:#e7e5e4; }",
    ".cc-peer-status { font-size:10px;color:#78716c; }",
    ".cc-camera-preview { width:200px;height:150px;border-radius:12px;object-fit:cover;transform:scaleX(-1);border:1px solid rgba(61,61,77,0.4);background:#000; }",
    ".cc-ctrl-cam { background:rgba(59,130,246,0.2);color:#60a5fa; }",
    ".cc-ctrl-cam.off { background:rgba(107,114,128,0.2);color:#9ca3af; }",
    ".cc-controls { display:flex;align-items:center;justify-content:center;gap:16px;padding:16px;background:rgba(15,15,23,0.85);border-top:1px solid rgba(61,61,77,0.3); }",
    ".cc-ctrl-btn { width:48px;height:48px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s; }",
    ".cc-ctrl-mic { background:rgba(34,197,94,0.2);color:#22c55e; }",
    ".cc-ctrl-mic.muted { background:rgba(239,68,68,0.2);color:#ef4444; }",
    ".cc-ctrl-hangup { background:#ef4444;color:#fff; }",
    ".cc-ctrl-hangup:hover { background:#dc2626; }",
    ".cc-ended { display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px; }",
    ".cc-ended h2 { font-size:18px;color:#e7e5e4; }",
    ".cc-ended p { font-size:13px;color:#78716c; }",
    ".cc-timer { font-size:12px;color:#78716c;font-variant-numeric:tabular-nums; }",
  ].join("\n");

  var _defaultColors = ["#f472b6", "#60a5fa", "#fb923c", "#34d399", "#a78bfa", "#818cf8"];
  var _callStartTime = null;
  var _timerEl = null;
  var _timerInterval = null;

  function getInitial(name) { return name ? name.charAt(0).toUpperCase() : "?"; }

  // ─── SVG icon builders (safe, no innerHTML) ───
  function createSvgIcon(paths, size) {
    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", String(size || 20));
    svg.setAttribute("height", String(size || 20));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      var el;
      if (p.tag === "line") {
        el = document.createElementNS(svgNS, "line");
        el.setAttribute("x1", p.x1); el.setAttribute("y1", p.y1);
        el.setAttribute("x2", p.x2); el.setAttribute("y2", p.y2);
      } else if (p.tag === "circle") {
        el = document.createElementNS(svgNS, "circle");
        el.setAttribute("cx", p.cx); el.setAttribute("cy", p.cy); el.setAttribute("r", p.r);
      } else {
        el = document.createElementNS(svgNS, "path");
        el.setAttribute("d", p.d);
      }
      svg.appendChild(el);
    }
    return svg;
  }

  function micIcon() {
    return createSvgIcon([
      { d: "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" },
      { d: "M19 10v2a7 7 0 0 1-14 0v-2" },
      { tag: "line", x1: "12", y1: "19", x2: "12", y2: "23" },
      { tag: "line", x1: "8", y1: "23", x2: "16", y2: "23" },
    ]);
  }

  function micOffIcon() {
    return createSvgIcon([
      { tag: "line", x1: "1", y1: "1", x2: "23", y2: "23" },
      { d: "M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" },
      { d: "M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17" },
      { tag: "line", x1: "12", y1: "19", x2: "12", y2: "23" },
      { tag: "line", x1: "8", y1: "23", x2: "16", y2: "23" },
    ]);
  }

  function phoneOffIcon() {
    return createSvgIcon([
      { d: "M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" },
      { tag: "line", x1: "23", y1: "1", x2: "1", y2: "23" },
    ]);
  }

  function cameraIcon() {
    return createSvgIcon([
      { d: "M23 7l-7 5 7 5V7z" },
      { d: "M1 5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5z" },
    ]);
  }

  function cameraOffIcon() {
    return createSvgIcon([
      { tag: "line", x1: "1", y1: "1", x2: "23", y2: "23" },
      { d: "M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6a2 2 0 0 1 2 2v3.28l4 2.5V19.5" },
    ]);
  }

  // ─── Render ───
  function render() {
    _root = document.getElementById("crow-call-root");
    if (!_root) return;

    var styleEl = document.createElement("style");
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);

    renderPreCall();
  }

  function renderPreCall() {
    _state = "pre-call";
    var cfg = window.CrowCallConfig || {};

    _root.textContent = "";
    var container = document.createElement("div");
    container.className = "cc-precall";

    // Room info
    var info = document.createElement("div");
    info.className = "cc-room-info";
    var h2 = document.createElement("h2");
    h2.textContent = "Crow Call";
    var p = document.createElement("p");
    p.textContent = "Hosted by " + (cfg.hostName || "Host");
    info.appendChild(h2);
    info.appendChild(p);
    container.appendChild(info);

    // Mic test
    var micTest = document.createElement("div");
    micTest.className = "cc-mic-test";
    micTest.appendChild(micIcon());
    var micInner = document.createElement("div");
    var micLabel = document.createElement("div");
    micLabel.style.cssText = "font-size:12px;color:#a8a29e;margin-bottom:4px;";
    micLabel.textContent = "Microphone";
    micInner.appendChild(micLabel);
    var micLevel = document.createElement("div");
    micLevel.className = "cc-mic-level";
    var micFill = document.createElement("div");
    micFill.className = "cc-mic-level-fill";
    micFill.id = "cc-mic-fill";
    micLevel.appendChild(micFill);
    micInner.appendChild(micLevel);
    micTest.appendChild(micInner);
    container.appendChild(micTest);

    // Camera preview
    var cameraPreview = document.createElement("video");
    cameraPreview.id = "cc-camera-preview";
    cameraPreview.className = "cc-camera-preview";
    cameraPreview.autoplay = true;
    cameraPreview.playsInline = true;
    cameraPreview.muted = true;
    cameraPreview.style.display = "none";
    container.appendChild(cameraPreview);

    // Camera toggle for pre-call
    var camToggle = document.createElement("button");
    camToggle.style.cssText = "padding:8px 20px;font-size:13px;font-weight:600;color:#60a5fa;background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.3);border-radius:8px;cursor:pointer;transition:background 0.15s;";
    camToggle.textContent = "Turn on camera";
    camToggle.onclick = function() {
      var preview = document.getElementById("cc-camera-preview");
      if (preview && preview.style.display === "none") {
        navigator.mediaDevices.getUserMedia({ video: VIDEO_PREVIEW_CONSTRAINTS })
          .then(function(stream) {
            preview.srcObject = stream;
            preview.style.display = "block";
            camToggle.textContent = "Turn off camera";
            _precallCameraStream = stream;
          }).catch(function() {
            camToggle.textContent = "Camera unavailable";
            camToggle.disabled = true;
          });
      } else if (preview) {
        if (_precallCameraStream) {
          _precallCameraStream.getTracks().forEach(function(t) { t.stop(); });
          _precallCameraStream = null;
        }
        preview.srcObject = null;
        preview.style.display = "none";
        camToggle.textContent = "Turn on camera";
      }
    };
    container.appendChild(camToggle);

    // Join button
    var joinBtn = document.createElement("button");
    joinBtn.className = "cc-join-btn";
    joinBtn.textContent = "Join Call";
    joinBtn.onclick = function() { startCall(); };
    container.appendChild(joinBtn);

    _root.appendChild(container);
    startMicPreview();
  }

  function startMicPreview() {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function(stream) {
        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        var source = _audioCtx.createMediaStreamSource(stream);
        _localAnalyser = _audioCtx.createAnalyser();
        _localAnalyser.fftSize = 256;
        source.connect(_localAnalyser);

        var data = new Uint8Array(_localAnalyser.frequencyBinCount);
        var fill = document.getElementById("cc-mic-fill");

        function update() {
          if (_state !== "pre-call") return;
          _localAnalyser.getByteFrequencyData(data);
          var sum = 0;
          for (var i = 0; i < data.length; i++) sum += data[i];
          var level = Math.min((sum / data.length) / 60 * 100, 100);
          if (fill) fill.style.width = level + "%";
          requestAnimationFrame(update);
        }
        requestAnimationFrame(update);

        stream.getTracks().forEach(function(t) { t.stop(); });
      })
      .catch(function() {
        var fill = document.getElementById("cc-mic-fill");
        if (fill) fill.style.background = "#ef4444";
      });
  }

  function startCall() {
    var startWithVideo = !!_precallCameraStream;

    // Stop pre-call camera preview (the real call will acquire its own stream)
    if (_precallCameraStream) {
      _precallCameraStream.getTracks().forEach(function(t) { t.stop(); });
      _precallCameraStream = null;
    }

    _state = "in-call";
    _callStartTime = Date.now();
    renderInCall();

    if (window.CrowCalls && !window.CrowCalls.isConnected()) {
      var cfg = window.CrowCallConfig || {};
      window.CrowCalls.init({
        wsUrl: cfg.wsUrl,
        roomCode: cfg.roomCode,
        token: cfg.token,
        gatewayUrl: cfg.gatewayUrl,
        name: cfg.userName || "User",
      });
    }

    // If user had camera preview on, enable video after connection
    if (startWithVideo && window.CrowCalls) {
      // Short delay to let WS connect and peers establish
      setTimeout(function() {
        if (window.CrowCalls && !window.CrowCalls.getVideoEnabled()) {
          window.CrowCalls.toggleVideo();
        }
      }, 1500);
    }
  }

  function renderInCall() {
    _root.textContent = "";
    var container = document.createElement("div");
    container.className = "cc-incall";

    _peerGrid = document.createElement("div");
    _peerGrid.className = "cc-peer-grid";
    container.appendChild(_peerGrid);

    _controlBar = document.createElement("div");
    _controlBar.className = "cc-controls";

    _timerEl = document.createElement("div");
    _timerEl.className = "cc-timer";
    _timerEl.textContent = "0:00";
    _controlBar.appendChild(_timerEl);

    // Mic toggle
    var micBtn = document.createElement("button");
    micBtn.className = "cc-ctrl-btn cc-ctrl-mic";
    micBtn.id = "cc-mic-btn";
    micBtn.appendChild(micIcon());
    micBtn.onclick = function() {
      if (window.CrowCalls) window.CrowCalls.toggleMute();
      var muted = window.CrowCalls ? window.CrowCalls.isMuted() : false;
      micBtn.className = "cc-ctrl-btn cc-ctrl-mic" + (muted ? " muted" : "");
      micBtn.textContent = "";
      micBtn.appendChild(muted ? micOffIcon() : micIcon());
    };
    _controlBar.appendChild(micBtn);

    // Camera toggle
    var camBtn = document.createElement("button");
    camBtn.className = "cc-ctrl-btn cc-ctrl-cam off";
    camBtn.id = "cc-cam-btn";
    camBtn.appendChild(cameraOffIcon());
    camBtn.onclick = function() {
      if (window.CrowCalls) window.CrowCalls.toggleVideo();
    };
    _controlBar.appendChild(camBtn);

    // Hang up
    var hangupBtn = document.createElement("button");
    hangupBtn.className = "cc-ctrl-btn cc-ctrl-hangup";
    hangupBtn.appendChild(phoneOffIcon());
    hangupBtn.onclick = function() { endCall(); };
    _controlBar.appendChild(hangupBtn);

    container.appendChild(_controlBar);
    _root.appendChild(container);

    _timerInterval = setInterval(updateTimer, 1000);
    requestAnimationFrame(updatePeerGrid);
  }

  function updateTimer() {
    if (!_timerEl || !_callStartTime) return;
    var elapsed = Math.floor((Date.now() - _callStartTime) / 1000);
    var mins = Math.floor(elapsed / 60);
    var secs = elapsed % 60;
    _timerEl.textContent = mins + ":" + (secs < 10 ? "0" : "") + secs;
  }

  function updatePeerGrid() {
    if (_state !== "in-call") return;
    requestAnimationFrame(updatePeerGrid);

    if (!window.CrowCalls || !_peerGrid) return;

    var calls = window.CrowCalls;
    var members = calls.getMembers();
    var myUid = calls.getMyUid();

    var count = members.length;
    if (count <= 1) {
      _peerGrid.style.gridTemplateColumns = "1fr";
    } else if (count <= 4) {
      _peerGrid.style.gridTemplateColumns = "1fr 1fr";
    } else {
      _peerGrid.style.gridTemplateColumns = "1fr 1fr";
    }

    var currentTiles = {};
    var existing = _peerGrid.querySelectorAll("[data-uid]");
    for (var i = 0; i < existing.length; i++) {
      currentTiles[existing[i].getAttribute("data-uid")] = existing[i];
    }

    var memberSet = {};
    for (var i = 0; i < members.length; i++) {
      var uid = typeof members[i] === "string" ? members[i] : members[i];
      memberSet[uid] = true;

      if (!currentTiles[uid]) {
        var profile = _peerProfiles[uid] || {
          name: uid === myUid ? "You" : "User",
          color: _defaultColors[i % _defaultColors.length],
        };
        var tile = createPeerTile(uid, profile, uid === myUid);
        _peerGrid.appendChild(tile);
      }
    }

    for (var uid in currentTiles) {
      if (!memberSet[uid]) {
        currentTiles[uid].parentNode.removeChild(currentTiles[uid]);
      }
    }
  }

  function createPeerTile(uid, profile, isMe) {
    var tile = document.createElement("div");
    tile.className = "cc-peer-tile";
    tile.setAttribute("data-uid", uid);

    var avatar = document.createElement("div");
    avatar.className = "cc-peer-avatar";
    avatar.style.background = profile.color;
    avatar.textContent = getInitial(profile.name);
    tile.appendChild(avatar);

    // Video element (hidden until camera is on)
    var videoEl = document.createElement("video");
    videoEl.className = "cc-peer-video" + (isMe ? " self-view" : "");
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.muted = true;
    videoEl.style.display = "none";
    tile.appendChild(videoEl);

    // Name overlay (shown over video when video is active)
    var overlay = document.createElement("div");
    overlay.className = "cc-peer-overlay";
    var name = document.createElement("div");
    name.className = "cc-peer-name";
    name.textContent = isMe ? profile.name + " (you)" : profile.name;
    overlay.appendChild(name);
    var status = document.createElement("div");
    status.className = "cc-peer-status";
    status.textContent = isMe ? "" : "connecting...";
    overlay.appendChild(status);
    tile.appendChild(overlay);

    // Attach video if already available
    updateTileVideo(tile, uid, isMe);

    return tile;
  }

  /**
   * Update a tile's video display based on current state.
   */
  function updateTileVideo(tile, uid, isMe) {
    if (!tile || !window.CrowCalls) return;
    var videoEl = tile.querySelector(".cc-peer-video");
    var avatar = tile.querySelector(".cc-peer-avatar");
    if (!videoEl || !avatar) return;

    var showVideo = !!_peerVideoStates[uid];
    if (showVideo) {
      var videoSrc = null;
      if (isMe) {
        videoSrc = window.CrowCalls.getLocalVideoStream();
      } else {
        var peerVid = window.CrowCalls.getPeerVideoEl(uid);
        videoSrc = peerVid ? peerVid.srcObject : null;
      }
      if (videoSrc) {
        videoEl.srcObject = videoSrc;
        videoEl.style.display = "block";
        avatar.style.display = "none";
        return;
      }
    }
    videoEl.style.display = "none";
    videoEl.srcObject = null;
    avatar.style.display = "flex";
  }

  function endCall() {
    _state = "ended";
    clearInterval(_timerInterval);
    _peerVideoStates = {};

    // Stop pre-call camera if still alive
    if (_precallCameraStream) {
      _precallCameraStream.getTracks().forEach(function(t) { t.stop(); });
      _precallCameraStream = null;
    }

    if (window.CrowCalls) {
      window.CrowCalls.disconnect();
    }

    _root.textContent = "";
    var container = document.createElement("div");
    container.className = "cc-ended";

    var elapsed = _callStartTime ? Math.floor((Date.now() - _callStartTime) / 1000) : 0;
    var mins = Math.floor(elapsed / 60);
    var secs = elapsed % 60;

    var h2 = document.createElement("h2");
    h2.textContent = "Call ended";
    container.appendChild(h2);

    var duration = document.createElement("p");
    duration.textContent = mins + ":" + (secs < 10 ? "0" : "") + secs;
    container.appendChild(duration);

    _root.appendChild(container);
  }

  // ─── CrowCalls event integration ───
  function registerHandlers() {
    if (!window.CrowCalls) {
      setTimeout(registerHandlers, 100);
      return;
    }

    var calls = window.CrowCalls;

    calls.on("peer-profile", function(data) {
      _peerProfiles[data.uid] = { name: data.name, color: data.color || _defaultColors[0] };
      if (_peerGrid) {
        var tile = _peerGrid.querySelector('[data-uid="' + data.uid + '"]');
        if (tile) {
          var avatar = tile.querySelector(".cc-peer-avatar");
          var nameEl = tile.querySelector(".cc-peer-name");
          if (avatar) {
            avatar.style.background = data.color || _defaultColors[0];
            avatar.textContent = getInitial(data.name);
          }
          if (nameEl) nameEl.textContent = data.name;
        }
      }
    });

    calls.on("peer-connected", function(data) {
      var tile = _peerGrid ? _peerGrid.querySelector('[data-uid="' + data.uid + '"]') : null;
      if (tile) {
        var status = tile.querySelector(".cc-peer-status");
        if (status) status.textContent = "";
      }
    });

    calls.on("peer-mute", function(data) {
      _mutedPeers[data.uid] = data.muted;
      var tile = _peerGrid ? _peerGrid.querySelector('[data-uid="' + data.uid + '"]') : null;
      if (tile) {
        if (data.muted) {
          tile.classList.add("muted-peer");
        } else {
          tile.classList.remove("muted-peer");
        }
      }
    });

    calls.on("room-full", function() {
      endCall();
    });

    calls.on("mute-changed", function(data) {
      var micBtn = document.getElementById("cc-mic-btn");
      if (micBtn) {
        micBtn.className = "cc-ctrl-btn cc-ctrl-mic" + (data.muted ? " muted" : "");
        micBtn.textContent = "";
        micBtn.appendChild(data.muted ? micOffIcon() : micIcon());
      }
    });

    calls.on("video-changed", function(data) {
      // Update camera button
      var camBtn = document.getElementById("cc-cam-btn");
      if (camBtn) {
        camBtn.className = "cc-ctrl-btn cc-ctrl-cam" + (data.videoEnabled ? "" : " off");
        camBtn.textContent = "";
        camBtn.appendChild(data.videoEnabled ? cameraIcon() : cameraOffIcon());
      }
      // Update self tile video
      var myUid = calls.getMyUid();
      if (myUid) {
        _peerVideoStates[myUid] = data.videoEnabled;
        var tile = _peerGrid ? _peerGrid.querySelector('[data-uid="' + myUid + '"]') : null;
        if (tile) updateTileVideo(tile, myUid, true);
      }
    });

    calls.on("peer-video-state", function(data) {
      _peerVideoStates[data.uid] = data.videoEnabled;
      var tile = _peerGrid ? _peerGrid.querySelector('[data-uid="' + data.uid + '"]') : null;
      if (tile) updateTileVideo(tile, data.uid, false);
    });

    calls.on("peer-video-track", function(data) {
      // When remote video track arrives, update tile
      var tile = _peerGrid ? _peerGrid.querySelector('[data-uid="' + data.uid + '"]') : null;
      if (tile) updateTileVideo(tile, data.uid, false);
    });
  }

  // ─── Initialize ───
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
  registerHandlers();

})();
