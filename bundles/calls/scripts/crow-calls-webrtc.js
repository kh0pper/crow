/**
 * Crow Calls — Standalone WebRTC Module
 *
 * Peer-to-peer audio (+ video in Phase 2) calling with its own WebSocket
 * connection to the gateway's /calls/ws signaling relay. No dependency on
 * window.CrowWS or the AI companion.
 *
 * Exposes window.CrowCalls as the central API and event bus.
 */
(function() {
  "use strict";

  var MAX_PEERS = 4;
  var SIGNALING_TIMEOUT = 10000;
  var ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
  var HEARTBEAT_INTERVAL = 25000;

  // ─── State ───
  var _myUid = null;
  var _peers = {};       // uid → { pc, audioEl, videoEl, dataChannel, iceBuf, offerTimer, remoteSet, representationMode }
  var _localStream = null;
  var _localVideoStream = null;
  var _muted = false;
  var _videoEnabled = false;
  var _representationMode = "audio";
  var _peerRepModes = {};  // uid → mode string
  var _lastMembers = [];
  var _ws = null;
  var _wsConnected = false;
  var _reconnectAttempts = 0;
  var _reconnectTimer = null;
  var _heartbeatTimer = null;
  var _config = null;

  // SDP renegotiation mutex: prevents glare from concurrent negotiations
  // Per-peer: _peers[uid]._isNegotiating, _peers[uid]._negotiationQueue
  var VIDEO_CONSTRAINTS = {
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 15, max: 20 },
  };

  // ─── Bandwidth adaptation ───
  var BITRATE_PROFILES = {
    // peerCount → { maxBitrate (bps), width, height }
    1: { maxBitrate: 500000, width: 640, height: 480 },
    2: { maxBitrate: 300000, width: 640, height: 480 },
    3: { maxBitrate: 200000, width: 320, height: 240 },
  };
  var STATS_POLL_INTERVAL = 5000;
  var LOSS_HALVE_THRESHOLD = 0.05;     // 5% packet loss → halve bitrate
  var LOSS_DISABLE_THRESHOLD = 0.15;   // 15% → fall back to audio
  var LOSS_RECOVERY_THRESHOLD = 0.02;  // < 2% sustained → restore
  var RECOVERY_SUSTAIN_MS = 30000;     // 30s of low loss to recover

  var _statsTimer = null;
  var _currentBitrate = 500000;
  var _baseBitrate = 500000;           // profile bitrate before loss adaptation
  var _videoDisabledByBandwidth = false;
  var _recoveryStart = 0;              // timestamp when loss first dropped below recovery threshold
  var _peerBandwidthPrefs = {};        // uid → "none" | "low" | "normal"
  var _deviceTier = "normal";          // "low" | "mid" | "normal" — set once at load

  // ─── Event bus ───
  var _handlers = {};  // type → [fn, fn, ...]

  function on(type, fn) {
    if (!_handlers[type]) _handlers[type] = [];
    _handlers[type].push(fn);
  }

  function off(type, fn) {
    if (!_handlers[type]) return;
    _handlers[type] = _handlers[type].filter(function(h) { return h !== fn; });
  }

  function emit(type, data) {
    var list = _handlers[type];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](data); } catch(e) { console.error("[crow-calls] handler error:", e); }
    }
  }

  // ─── WebSocket connection ───
  function connectWs() {
    if (!_config) return;
    if (_ws && (_ws.readyState === 0 || _ws.readyState === 1)) return;

    // Generate a uid if we don't have one
    if (!_myUid) {
      _myUid = "u_" + Math.random().toString(36).substr(2, 8);
    }

    var url = _config.wsUrl +
      "?room=" + encodeURIComponent(_config.roomCode) +
      "&token=" + encodeURIComponent(_config.token) +
      "&uid=" + encodeURIComponent(_myUid);

    if (_config.name) url += "&name=" + encodeURIComponent(_config.name);
    if (_config.color) url += "&color=" + encodeURIComponent(_config.color);

    try {
      _ws = new WebSocket(url);
    } catch(e) {
      console.error("[crow-calls] WebSocket creation failed:", e);
      scheduleReconnect();
      return;
    }

    _ws.onopen = function() {
      _wsConnected = true;
      _reconnectAttempts = 0;
      console.log("[crow-calls] connected to signaling relay");
      emit("ws-connected", {});

      // Start heartbeat
      clearInterval(_heartbeatTimer);
      _heartbeatTimer = setInterval(function() {
        if (_ws && _ws.readyState === 1) {
          try { _ws.send(JSON.stringify({ type: "ping" })); } catch(e) {}
        }
      }, HEARTBEAT_INTERVAL);
    };

    _ws.onmessage = function(evt) {
      var msg;
      try { msg = JSON.parse(evt.data); } catch(e) { return; }

      var type = msg.type;
      if (!type) return;

      // Group membership changed
      if (type === "group-update" && msg.members) {
        var memberUids = msg.members.map(function(m) { return m.uid; });
        // Find our uid from the members list if server assigned one
        for (var i = 0; i < msg.members.length; i++) {
          // Our uid should match what we sent in the query
          // The server echoes it back in group-update
        }
        onGroupUpdate(memberUids);
        emit("group-update", msg);
      }

      // WebRTC signaling
      if (type === "webrtc-signal" && msg.from) {
        if (msg.signal_type === "offer" && msg.sdp) {
          handleOffer(msg.from, msg.sdp);
        } else if (msg.signal_type === "answer" && msg.sdp) {
          handleAnswer(msg.from, msg.sdp);
        } else if (msg.signal_type === "ice" && msg.candidate) {
          handleIce(msg.from, msg.candidate);
        }
      }

      // Peer mute state
      if (type === "webrtc-mute" && msg.from) {
        emit("peer-mute", { uid: msg.from, muted: msg.muted });
      }

      // Peer video state
      if (type === "webrtc-video-state" && msg.from) {
        emit("peer-video-state", { uid: msg.from, videoEnabled: msg.videoEnabled });
      }

      // Peer representation mode
      if (type === "webrtc-representation" && msg.from) {
        _peerRepModes[msg.from] = msg.mode;
        emit("peer-representation", { uid: msg.from, mode: msg.mode });
      }

      // Peer bandwidth preference
      if (type === "webrtc-bandwidth-pref" && msg.from) {
        _peerBandwidthPrefs[msg.from] = msg.pref || "normal";
        applyBitrateToPeer(msg.from, _currentBitrate);
        emit("peer-bandwidth-pref", { uid: msg.from, pref: msg.pref });
      }

      // Peer profile
      if (type === "peer-profile" && msg.from) {
        emit("peer-profile", { uid: msg.from, name: msg.name, color: msg.color });
      }

      // Room full error
      if (type === "error" && msg.error === "room_full") {
        emit("room-full", msg);
      }

      // DataChannel messages come through WebRTC, not WS.
      // But forward any unhandled types as generic events.
      emit(type, msg);
    };

    _ws.onclose = function(evt) {
      _wsConnected = false;
      clearInterval(_heartbeatTimer);
      console.log("[crow-calls] disconnected:", evt.code, evt.reason);
      emit("ws-disconnected", { code: evt.code, reason: evt.reason });

      if (evt.code !== 4001 && evt.code !== 4002) {
        // Not an intentional close (room full or replaced), try reconnect
        scheduleReconnect();
      }
    };

    _ws.onerror = function() {
      // onclose will fire after this
    };
  }

  function scheduleReconnect() {
    if (_reconnectTimer) return;
    _reconnectAttempts++;
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s, with jitter
    var delay = Math.min(1000 * Math.pow(2, _reconnectAttempts - 1), 30000);
    var jitter = Math.random() * 1000;
    delay = Math.floor(delay + jitter);

    console.log("[crow-calls] reconnecting in " + delay + "ms (attempt " + _reconnectAttempts + ")");
    _reconnectTimer = setTimeout(function() {
      _reconnectTimer = null;
      connectWs();
    }, delay);
  }

  function sendToRelay(data) {
    if (!_ws || _ws.readyState !== 1) return;
    try { _ws.send(JSON.stringify(data)); } catch(e) {}
  }

  // ─── TURN credential fetching ───
  function fetchTurnCreds() {
    if (!_config || !_config.gatewayUrl) return Promise.resolve(ICE_SERVERS);
    return fetch(_config.gatewayUrl + "/api/turn-credentials")
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) {
        if (!d || !d.urls) return ICE_SERVERS;
        return ICE_SERVERS.concat([{
          urls: d.urls,
          username: d.username,
          credential: d.credential,
        }]);
      })
      .catch(function() { return ICE_SERVERS; });
  }

  // ─── Mic access ───
  function getLocalStream() {
    if (_localStream) return Promise.resolve(_localStream);
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    }).then(function(stream) {
      _localStream = stream;
      return stream;
    });
  }

  function getClonedAudioTrack() {
    if (!_localStream) return null;
    var track = _localStream.getAudioTracks()[0];
    if (!track) return null;
    var cloned = track.clone();
    cloned.enabled = !_muted;
    return cloned;
  }

  // ─── Video access ───
  function getLocalVideoStream() {
    if (_localVideoStream) return Promise.resolve(_localVideoStream);
    return navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS })
      .then(function(stream) {
        _localVideoStream = stream;
        return stream;
      });
  }

  function getClonedVideoTrack() {
    if (!_localVideoStream) return null;
    var track = _localVideoStream.getVideoTracks()[0];
    if (!track) return null;
    var cloned = track.clone();
    cloned.enabled = _videoEnabled;
    return cloned;
  }

  // ─── SDP renegotiation helpers ───
  function safeNegotiate(peer, uid, negotiateFn) {
    if (peer._isNegotiating) {
      peer._negotiationQueue.push(negotiateFn);
      return;
    }
    peer._isNegotiating = true;
    try { negotiateFn(); } catch(e) {
      console.error("[crow-calls] negotiation error:", e);
      peer._isNegotiating = false;
    }
  }

  function drainNegotiationQueue(peer, uid) {
    peer._isNegotiating = false;
    if (peer._negotiationQueue.length > 0) {
      var next = peer._negotiationQueue.shift();
      safeNegotiate(peer, uid, next);
    }
  }

  // ─── Device capability detection ───
  // Run once at load. navigator.deviceMemory is Chrome/Edge only; undefined → mid-tier.
  function detectDeviceTier() {
    var mem = navigator.deviceMemory || 4; // undefined → treat as 4GB (mid-tier)
    var cores = navigator.hardwareConcurrency || 4;
    var conn = navigator.connection ? navigator.connection.effectiveType : "4g";

    if (mem < 2 || conn === "2g" || conn === "slow-2g") return "low";
    if (mem < 4 || cores < 4 || conn === "3g") return "mid";
    return "normal";
  }
  _deviceTier = detectDeviceTier();

  // ─── Bandwidth adaptation functions ───

  /**
   * Get the target bitrate profile for the current number of peers.
   */
  function getBitrateProfile() {
    var count = Object.keys(_peers).length;
    if (count <= 0) count = 1;
    if (count > 3) count = 3; // 3+ peers use the 3-peer profile
    return BITRATE_PROFILES[count] || BITRATE_PROFILES[1];
  }

  /**
   * Apply bitrate and resolution to all video senders.
   */
  function applyBitrateToAllPeers() {
    var profile = getBitrateProfile();
    _baseBitrate = profile.maxBitrate;
    _currentBitrate = _baseBitrate;

    var uids = Object.keys(_peers);
    for (var i = 0; i < uids.length; i++) {
      applyBitrateToPeer(uids[i], _currentBitrate);
    }

    // Apply resolution constraints if profile dictates lower res
    applyResolutionConstraint(profile.width, profile.height);
  }

  /**
   * Set max bitrate on a single peer's video sender.
   */
  function applyBitrateToPeer(uid, bitrate) {
    var peer = _peers[uid];
    if (!peer) return;

    // Honor peer's bandwidth preference
    var pref = _peerBandwidthPrefs[uid] || "normal";
    if (pref === "none") {
      // Peer requested no video: replace with null track
      replaceVideoTrack(peer, null);
      return;
    }
    if (pref === "low") {
      bitrate = Math.min(bitrate, 150000); // cap at 150kbps for "low"
    }

    var senders = peer.pc.getSenders();
    for (var j = 0; j < senders.length; j++) {
      if (senders[j].track && senders[j].track.kind === "video") {
        try {
          var params = senders[j].getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          params.encodings[0].maxBitrate = bitrate;
          senders[j].setParameters(params).catch(function(e) {
            // setParameters not supported on all browsers; non-fatal
          });
        } catch(e) {}
      }
    }
  }

  /**
   * Replace video track on a peer (used for bandwidth pref "none").
   */
  function replaceVideoTrack(peer, track) {
    var senders = peer.pc.getSenders();
    for (var j = 0; j < senders.length; j++) {
      if (senders[j].track && senders[j].track.kind === "video") {
        senders[j].replaceTrack(track).catch(function() {});
        return;
      }
    }
  }

  /**
   * Apply resolution constraint to the local video track (no renegotiation needed).
   */
  function applyResolutionConstraint(width, height) {
    if (!_localVideoStream) return;
    var track = _localVideoStream.getVideoTracks()[0];
    if (!track) return;
    try {
      track.applyConstraints({
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: 15, max: 20 },
      }).catch(function() {});
    } catch(e) {}
  }

  /**
   * Poll getStats() on all peer connections, compute average packet loss,
   * and adapt bitrate/video accordingly.
   */
  function startQualityMonitoring() {
    if (_statsTimer) return;
    _statsTimer = setInterval(function() {
      if (!_videoEnabled || Object.keys(_peers).length === 0) return;

      var totalLoss = 0;
      var totalPackets = 0;
      var peerCount = 0;

      var uids = Object.keys(_peers);
      var pending = uids.length;

      for (var i = 0; i < uids.length; i++) {
        (function(uid) {
          var peer = _peers[uid];
          if (!peer || !peer.pc) { pending--; return; }
          peer.pc.getStats(null).then(function(stats) {
            stats.forEach(function(report) {
              if (report.type === "outbound-rtp" && report.kind === "video") {
                // Use fractionLost from associated remote-inbound-rtp if available
                if (report.packetsSent > 0) {
                  totalPackets += report.packetsSent;
                  peerCount++;
                }
              }
              if (report.type === "remote-inbound-rtp" && report.kind === "video") {
                if (report.packetsLost !== undefined && report.packetsReceived !== undefined) {
                  var total = report.packetsLost + report.packetsReceived;
                  if (total > 0) {
                    totalLoss += report.packetsLost / total;
                    peerCount++;
                  }
                }
              }
            });
            pending--;
            if (pending <= 0) {
              adaptToBandwidth(peerCount > 0 ? totalLoss / peerCount : 0);
            }
          }).catch(function() { pending--; });
        })(uids[i]);
      }
    }, STATS_POLL_INTERVAL);
  }

  function stopQualityMonitoring() {
    if (_statsTimer) {
      clearInterval(_statsTimer);
      _statsTimer = null;
    }
  }

  /**
   * React to measured packet loss rate.
   */
  function adaptToBandwidth(avgLoss) {
    if (avgLoss > LOSS_DISABLE_THRESHOLD) {
      // Severe loss: disable video entirely
      if (!_videoDisabledByBandwidth && _videoEnabled) {
        _videoDisabledByBandwidth = true;
        toggleVideo(); // turns off
        emit("bandwidth-fallback", { reason: "high_loss", loss: avgLoss });
        console.warn("[crow-calls] video disabled due to " + Math.round(avgLoss * 100) + "% packet loss");
      }
      _recoveryStart = 0;
      return;
    }

    if (avgLoss > LOSS_HALVE_THRESHOLD) {
      // Moderate loss: halve bitrate
      var newBitrate = Math.max(Math.floor(_currentBitrate / 2), 100000);
      if (newBitrate !== _currentBitrate) {
        _currentBitrate = newBitrate;
        var uids = Object.keys(_peers);
        for (var i = 0; i < uids.length; i++) applyBitrateToPeer(uids[i], _currentBitrate);
        emit("bandwidth-adapted", { bitrate: _currentBitrate, loss: avgLoss });
      }
      _recoveryStart = 0;
      return;
    }

    if (avgLoss < LOSS_RECOVERY_THRESHOLD) {
      // Low loss: track sustained recovery
      if (_recoveryStart === 0) {
        _recoveryStart = Date.now();
      } else if (Date.now() - _recoveryStart > RECOVERY_SUSTAIN_MS) {
        // Sustained low loss: restore baseline
        if (_videoDisabledByBandwidth) {
          _videoDisabledByBandwidth = false;
          toggleVideo(); // turns on
          emit("bandwidth-recovered", { reason: "loss_cleared" });
          console.log("[crow-calls] video restored after sustained low packet loss");
        }
        if (_currentBitrate < _baseBitrate) {
          _currentBitrate = _baseBitrate;
          var uids = Object.keys(_peers);
          for (var i = 0; i < uids.length; i++) applyBitrateToPeer(uids[i], _currentBitrate);
          emit("bandwidth-adapted", { bitrate: _currentBitrate, loss: avgLoss });
        }
        _recoveryStart = 0;
      }
    } else {
      _recoveryStart = 0;
    }
  }

  // ─── Peer connection management ───
  function createPeer(remoteUid, iceServers) {
    if (_peers[remoteUid]) return _peers[remoteUid];
    if (Object.keys(_peers).length >= MAX_PEERS) {
      console.warn("[crow-calls] peer limit reached, ignoring", remoteUid);
      return null;
    }

    var pc = new RTCPeerConnection({ iceServers: iceServers });
    var audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.style.display = "none";
    document.body.appendChild(audioEl);

    var peer = {
      pc: pc,
      audioEl: audioEl,
      videoEl: null,
      dataChannel: null,   // Phase 7: DataChannel for avatar state
      iceBuf: [],
      offerTimer: null,
      remoteSet: false,
      representationMode: "audio",
      _isNegotiating: false,
      _negotiationQueue: [],
    };
    _peers[remoteUid] = peer;

    // Add local audio track
    var track = getClonedAudioTrack();
    if (track) pc.addTrack(track, _localStream);

    // Add local video track (disabled unless video is on)
    var videoTrack = getClonedVideoTrack();
    if (videoTrack) {
      pc.addTrack(videoTrack, _localVideoStream);
    }

    // Create DataChannel (early, for Phase 7 avatar state sync)
    try {
      peer.dataChannel = pc.createDataChannel("crow-state", {
        ordered: false,
        maxRetransmits: 0,
      });
      peer.dataChannel.onmessage = function(evt) {
        try {
          var msg = JSON.parse(evt.data);
          emit("datachannel-message", { uid: remoteUid, data: msg });
        } catch(e) {}
      };
    } catch(e) {
      console.warn("[crow-calls] DataChannel creation failed:", e);
    }

    // Accept incoming DataChannel from remote peer
    pc.ondatachannel = function(evt) {
      peer.dataChannel = evt.channel;
      peer.dataChannel.onmessage = function(e2) {
        try {
          var msg = JSON.parse(e2.data);
          emit("datachannel-message", { uid: remoteUid, data: msg });
        } catch(e) {}
      };
    };

    // Remote tracks (audio + video)
    pc.ontrack = function(e) {
      if (e.track.kind === "audio") {
        if (e.streams && e.streams[0]) {
          audioEl.srcObject = e.streams[0];
        }
      }
      if (e.track.kind === "video") {
        if (!peer.videoEl) {
          peer.videoEl = document.createElement("video");
          peer.videoEl.autoplay = true;
          peer.videoEl.playsInline = true;
          peer.videoEl.muted = true; // remote video element must be muted (audio comes from audioEl)
          peer.videoEl.style.display = "none";
          document.body.appendChild(peer.videoEl);
        }
        if (e.streams && e.streams[0]) {
          peer.videoEl.srcObject = e.streams[0];
        }
        emit("peer-video-track", { uid: remoteUid, track: e.track });
      }
    };

    // ICE candidates → send to remote peer
    pc.onicecandidate = function(e) {
      if (e.candidate) {
        sendToRelay({
          type: "webrtc-signal",
          signal_type: "ice",
          to: remoteUid,
          candidate: e.candidate.toJSON(),
        });
      }
    };

    // Connection state monitoring
    pc.oniceconnectionstatechange = function() {
      var state = pc.iceConnectionState;
      if (state === "failed" || state === "disconnected" || state === "closed") {
        cleanupPeer(remoteUid);
        emit("peer-left", { uid: remoteUid });
      }
      if (state === "connected" || state === "completed") {
        if (peer.offerTimer) {
          clearTimeout(peer.offerTimer);
          peer.offerTimer = null;
        }
        emit("peer-connected", { uid: remoteUid });
      }
    };

    // SDP renegotiation mutex: drain queue when signaling returns to stable
    pc.onsignalingstatechange = function() {
      if (pc.signalingState === "stable") {
        drainNegotiationQueue(peer, remoteUid);
      }
    };

    return peer;
  }

  function cleanupPeer(uid) {
    var peer = _peers[uid];
    if (!peer) return;
    if (peer.offerTimer) clearTimeout(peer.offerTimer);
    try { peer.pc.close(); } catch(e) {}
    if (peer.audioEl && peer.audioEl.parentNode) {
      peer.audioEl.srcObject = null;
      peer.audioEl.parentNode.removeChild(peer.audioEl);
    }
    if (peer.videoEl && peer.videoEl.parentNode) {
      peer.videoEl.srcObject = null;
      peer.videoEl.parentNode.removeChild(peer.videoEl);
    }
    delete _peers[uid];
  }

  function cleanupAllPeers() {
    var uids = Object.keys(_peers);
    for (var i = 0; i < uids.length; i++) cleanupPeer(uids[i]);
  }

  function flushIceBuffer(peer) {
    peer.remoteSet = true;
    for (var i = 0; i < peer.iceBuf.length; i++) {
      try {
        peer.pc.addIceCandidate(new RTCIceCandidate(peer.iceBuf[i]));
      } catch(e) {}
    }
    peer.iceBuf = [];
  }

  // ─── Signaling ───
  function sendSignal(data) {
    data.type = "webrtc-signal";
    sendToRelay(data);
  }

  function initiateOffer(remoteUid) {
    fetchTurnCreds().then(function(iceServers) {
      return getLocalStream().then(function() {
        var peer = createPeer(remoteUid, iceServers);
        if (!peer) return;

        peer.pc.createOffer().then(function(offer) {
          return peer.pc.setLocalDescription(offer);
        }).then(function() {
          sendSignal({
            signal_type: "offer",
            to: remoteUid,
            sdp: peer.pc.localDescription.sdp,
          });

          peer.offerTimer = setTimeout(function() {
            if (_peers[remoteUid] && peer.pc.iceConnectionState !== "connected" &&
                peer.pc.iceConnectionState !== "completed") {
              console.warn("[crow-calls] signaling timeout for", remoteUid);
              cleanupPeer(remoteUid);
            }
          }, SIGNALING_TIMEOUT);
        }).catch(function(e) {
          console.error("[crow-calls] offer failed:", e);
        });
      });
    });
  }

  function handleOffer(fromUid, sdp) {
    fetchTurnCreds().then(function(iceServers) {
      return getLocalStream().then(function() {
        var peer = createPeer(fromUid, iceServers);
        if (!peer) return;

        peer.pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: sdp }))
          .then(function() {
            flushIceBuffer(peer);
            return peer.pc.createAnswer();
          })
          .then(function(answer) {
            return peer.pc.setLocalDescription(answer);
          })
          .then(function() {
            sendSignal({
              signal_type: "answer",
              to: fromUid,
              sdp: peer.pc.localDescription.sdp,
            });
          })
          .catch(function(e) {
            console.error("[crow-calls] answer failed:", e);
          });
      });
    });
  }

  function handleAnswer(fromUid, sdp) {
    var peer = _peers[fromUid];
    if (!peer) return;
    peer.pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: sdp }))
      .then(function() { flushIceBuffer(peer); })
      .catch(function(e) {
        console.error("[crow-calls] setRemoteDescription(answer) failed:", e);
      });
  }

  function handleIce(fromUid, candidate) {
    var peer = _peers[fromUid];
    if (!peer) return;
    if (!peer.remoteSet) {
      peer.iceBuf.push(candidate);
    } else {
      try {
        peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch(e) {}
    }
  }

  // ─── Group membership changes ───
  function onGroupUpdate(memberUids) {
    if (!_myUid) return;

    var prevSet = {};
    for (var i = 0; i < _lastMembers.length; i++) prevSet[_lastMembers[i]] = true;

    var currSet = {};
    for (var i = 0; i < memberUids.length; i++) currSet[memberUids[i]] = true;

    // New members: send offers (only if I was already in the group)
    if (_lastMembers.length > 0) {
      for (var i = 0; i < memberUids.length; i++) {
        var uid = memberUids[i];
        if (uid !== _myUid && !prevSet[uid] && !_peers[uid]) {
          initiateOffer(uid);
        }
      }
    }

    // Departed members: cleanup
    for (var i = 0; i < _lastMembers.length; i++) {
      var uid = _lastMembers[i];
      if (!currSet[uid]) {
        cleanupPeer(uid);
      }
    }

    _lastMembers = memberUids.slice();

    // Recalculate bitrate profile when peer count changes
    if (_videoEnabled) {
      applyBitrateToAllPeers();
    }
  }

  // ─── Public API ───

  function toggleMute() {
    _muted = !_muted;
    var uids = Object.keys(_peers);
    for (var i = 0; i < uids.length; i++) {
      var senders = _peers[uids[i]].pc.getSenders();
      for (var j = 0; j < senders.length; j++) {
        if (senders[j].track && senders[j].track.kind === "audio") {
          senders[j].track.enabled = !_muted;
        }
      }
    }
    sendToRelay({ type: "webrtc-mute", muted: _muted });
    emit("mute-changed", { muted: _muted });
  }

  function toggleVideo() {
    if (!_videoEnabled) {
      // Device gating: low-tier devices can't enable video
      if (_deviceTier === "low") {
        emit("video-error", { error: "Video unavailable on this device (low memory/network)" });
        return;
      }
      // Turn video on: acquire camera, add tracks to all peers
      getLocalVideoStream().then(function() {
        _videoEnabled = true;
        addVideoToAllPeers();
        applyBitrateToAllPeers();
        startQualityMonitoring();
        sendToRelay({ type: "webrtc-video-state", videoEnabled: true });
        emit("video-changed", { videoEnabled: true });
      }).catch(function(e) {
        console.error("[crow-calls] camera access denied:", e);
        emit("video-error", { error: e.message || "Camera access denied" });
      });
    } else {
      // Turn video off: disable tracks
      _videoEnabled = false;
      stopQualityMonitoring();
      var uids = Object.keys(_peers);
      for (var i = 0; i < uids.length; i++) {
        var senders = _peers[uids[i]].pc.getSenders();
        for (var j = 0; j < senders.length; j++) {
          if (senders[j].track && senders[j].track.kind === "video") {
            senders[j].track.enabled = false;
          }
        }
      }
      sendToRelay({ type: "webrtc-video-state", videoEnabled: false });
      emit("video-changed", { videoEnabled: false });
    }
  }

  /**
   * Add video track to all existing peer connections (with renegotiation).
   */
  function addVideoToAllPeers() {
    var uids = Object.keys(_peers);
    for (var i = 0; i < uids.length; i++) {
      addVideoToPeer(uids[i]);
    }
  }

  function addVideoToPeer(uid) {
    var peer = _peers[uid];
    if (!peer || !_localVideoStream) return;

    // Check if video sender already exists
    var senders = peer.pc.getSenders();
    var hasVideo = false;
    for (var j = 0; j < senders.length; j++) {
      if (senders[j].track && senders[j].track.kind === "video") {
        // Already have a video sender, just enable
        senders[j].track.enabled = true;
        hasVideo = true;
        break;
      }
      if (!senders[j].track && senders[j].kind === "video") {
        // Empty video sender slot: replace track
        var newTrack = getClonedVideoTrack();
        if (newTrack) senders[j].replaceTrack(newTrack);
        hasVideo = true;
        break;
      }
    }

    if (!hasVideo) {
      // Add new video track and renegotiate
      var track = getClonedVideoTrack();
      if (!track) return;

      safeNegotiate(peer, uid, function() {
        peer.pc.addTrack(track, _localVideoStream);
        peer.pc.createOffer().then(function(offer) {
          return peer.pc.setLocalDescription(offer);
        }).then(function() {
          sendSignal({
            signal_type: "offer",
            to: uid,
            sdp: peer.pc.localDescription.sdp,
          });
        }).catch(function(e) {
          console.error("[crow-calls] video renegotiation failed:", e);
          peer._isNegotiating = false;
        });
      });
    }
  }

  function setRepresentationMode(mode) {
    var valid = window.CrowCalls.validModes;
    var found = false;
    for (var i = 0; i < valid.length; i++) {
      if (valid[i] === mode) { found = true; break; }
    }
    if (!found) {
      console.warn("[crow-calls] invalid representation mode:", mode, "valid:", valid);
      return;
    }

    _representationMode = mode;

    // Toggle video based on mode
    if (mode === "camera" || mode === "both") {
      if (!_videoEnabled) toggleVideo();
    } else if (mode === "audio") {
      if (_videoEnabled) toggleVideo();
    }
    // "avatar" mode: companion handles this, no video toggle here

    sendToRelay({ type: "webrtc-representation", mode: mode });
    emit("representation-changed", { mode: mode });
  }

  function disconnect() {
    cleanupAllPeers();
    stopQualityMonitoring();
    _lastMembers = [];
    _peerRepModes = {};
    _peerBandwidthPrefs = {};
    _videoDisabledByBandwidth = false;
    _recoveryStart = 0;
    if (_ws) {
      try { _ws.close(1000, "User disconnect"); } catch(e) {}
      _ws = null;
    }
    _wsConnected = false;
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
    clearInterval(_heartbeatTimer);

    // Stop local video tracks
    if (_localVideoStream) {
      _localVideoStream.getTracks().forEach(function(t) { t.stop(); });
      _localVideoStream = null;
    }
    _videoEnabled = false;
    _representationMode = "audio";

    emit("disconnected", {});
  }

  /**
   * Initialize the calls module.
   * @param {Object} config - { wsUrl, roomCode, token, gatewayUrl, name?, color? }
   */
  function init(config) {
    _config = config;
    if (config.maxPeers) MAX_PEERS = config.maxPeers;

    // Device tier constraints
    if (_deviceTier === "low") {
      // Low-end: audio only by default, no video
      console.log("[crow-calls] low-tier device detected, defaulting to audio-only");
    }

    connectWs();
  }

  // ─── Expose API ───
  window.CrowCalls = {
    // Lifecycle
    init: init,
    disconnect: disconnect,

    // Event bus
    on: on,
    off: off,
    emit: emit,
    send: sendToRelay,

    // Audio
    toggleMute: toggleMute,
    isMuted: function() { return _muted; },
    getLocalStream: function() { return _localStream; },
    getPeerStream: function(uid) {
      var peer = _peers[uid];
      return (peer && peer.audioEl && peer.audioEl.srcObject) ? peer.audioEl.srcObject : null;
    },

    // Video
    toggleVideo: toggleVideo,
    getVideoEnabled: function() { return _videoEnabled; },
    getLocalVideoStream: function() { return _localVideoStream; },
    getPeerVideoEl: function(uid) {
      var peer = _peers[uid];
      return (peer && peer.videoEl) ? peer.videoEl : null;
    },

    // Representation modes
    setRepresentationMode: setRepresentationMode,
    getRepresentationMode: function() { return _representationMode; },
    getPeerRepresentationMode: function(uid) { return _peerRepModes[uid] || "audio"; },

    // Peers
    getMyUid: function() { return _myUid; },
    getPeerUids: function() { return Object.keys(_peers); },
    getPeerConnectionState: function(uid) {
      var peer = _peers[uid];
      return peer ? peer.pc.iceConnectionState : null;
    },
    getDataChannel: function(uid) {
      var peer = _peers[uid];
      return peer ? peer.dataChannel : null;
    },

    // Connection state
    isConnected: function() { return _wsConnected; },
    getMembers: function() { return _lastMembers.slice(); },

    // Bandwidth adaptation
    getDeviceTier: function() { return _deviceTier; },
    getCurrentBitrate: function() { return _currentBitrate; },
    isVideoDisabledByBandwidth: function() { return _videoDisabledByBandwidth; },
    setBandwidthPref: function(pref) {
      if (pref !== "none" && pref !== "low" && pref !== "normal") return;
      sendToRelay({ type: "webrtc-bandwidth-pref", pref: pref });
      emit("bandwidth-pref-changed", { pref: pref });
    },

    // Extension point: companion can extend valid representation modes
    validModes: ["audio", "camera"],

    // Extension point: companion can register track providers
    _trackProviders: {},
    registerTrackProvider: function(name, fn) {
      this._trackProviders[name] = fn;
    },
  };

  // Init is triggered by crow-call-ui.js startCall() when user clicks "Join Call".
  // No auto-init on page load — avoids premature WebSocket connections.

})();
