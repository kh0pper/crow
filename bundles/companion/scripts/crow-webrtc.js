(function() {
  "use strict";

  var MAX_PEERS = 4;
  var SIGNALING_TIMEOUT = 10000; // 10s for offer→answer
  var ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

  var _myUid = null;
  var _peers = {}; // uid → { pc, audioEl, iceBuf, offerTimer }
  var _localStream = null;
  var _muted = false;
  var _lastMembers = [];

  // ─── TURN credential fetching ───
  function fetchTurnCreds() {
    var cfg = window.CrowWebRTC || {};
    if (!cfg.gatewayUrl) return Promise.resolve(ICE_SERVERS);
    return fetch(cfg.gatewayUrl + "/api/turn-credentials")
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

  function getClonedTrack() {
    if (!_localStream) return null;
    var track = _localStream.getAudioTracks()[0];
    if (!track) return null;
    var cloned = track.clone();
    cloned.enabled = !_muted;
    return cloned;
  }

  // ─── Peer connection management ───
  function createPeer(remoteUid, iceServers) {
    if (_peers[remoteUid]) return _peers[remoteUid];
    if (Object.keys(_peers).length >= MAX_PEERS) {
      console.warn("[crow-webrtc] peer limit reached, ignoring", remoteUid);
      return null;
    }

    var pc = new RTCPeerConnection({ iceServers: iceServers });
    var audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.style.display = "none";
    document.body.appendChild(audioEl);

    var peer = { pc: pc, audioEl: audioEl, iceBuf: [], offerTimer: null, remoteSet: false };
    _peers[remoteUid] = peer;

    // Add local audio track
    var track = getClonedTrack();
    if (track) pc.addTrack(track, _localStream);

    // Remote audio
    pc.ontrack = function(e) {
      if (e.streams && e.streams[0]) {
        audioEl.srcObject = e.streams[0];
      }
    };

    // ICE candidates → send to remote peer
    pc.onicecandidate = function(e) {
      if (e.candidate) {
        sendSignal({
          signal_type: "ice",
          target_uid: remoteUid,
          candidate: e.candidate.toJSON(),
        });
      }
    };

    // Connection state monitoring
    pc.oniceconnectionstatechange = function() {
      var state = pc.iceConnectionState;
      if (state === "failed" || state === "disconnected" || state === "closed") {
        cleanupPeer(remoteUid);
        updateUI();
      }
      if (state === "connected" || state === "completed") {
        if (peer.offerTimer) {
          clearTimeout(peer.offerTimer);
          peer.offerTimer = null;
        }
        updateUI();
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
    delete _peers[uid];
  }

  function cleanupAllPeers() {
    var uids = Object.keys(_peers);
    for (var i = 0; i < uids.length; i++) cleanupPeer(uids[i]);
  }

  // Apply buffered ICE candidates after remote description is set
  function flushIceBuffer(peer) {
    peer.remoteSet = true;
    for (var i = 0; i < peer.iceBuf.length; i++) {
      try {
        peer.pc.addIceCandidate(new RTCIceCandidate(peer.iceBuf[i]));
      } catch(e) {
        console.warn("[crow-webrtc] buffered ICE failed:", e);
      }
    }
    peer.iceBuf = [];
  }

  // ─── Signaling ───
  function sendSignal(data) {
    data.type = "webrtc-signal";
    if (window.CrowWS && window.CrowWS._activeSocket) {
      try {
        window.CrowWS._activeSocket.send(JSON.stringify(data));
      } catch(e) {}
    }
  }

  function sendMuteState() {
    if (window.CrowWS && window.CrowWS._activeSocket) {
      try {
        window.CrowWS._activeSocket.send(JSON.stringify({
          type: "webrtc-mute",
          muted: _muted,
        }));
      } catch(e) {}
    }
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
            target_uid: remoteUid,
            sdp: peer.pc.localDescription.sdp,
          });

          // Signaling timeout
          peer.offerTimer = setTimeout(function() {
            if (_peers[remoteUid] && peer.pc.iceConnectionState !== "connected" &&
                peer.pc.iceConnectionState !== "completed") {
              console.warn("[crow-webrtc] signaling timeout for", remoteUid);
              cleanupPeer(remoteUid);
              updateUI();
            }
          }, SIGNALING_TIMEOUT);
        }).catch(function(e) {
          console.error("[crow-webrtc] offer failed:", e);
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
              target_uid: fromUid,
              sdp: peer.pc.localDescription.sdp,
            });
          })
          .catch(function(e) {
            console.error("[crow-webrtc] answer failed:", e);
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
        console.error("[crow-webrtc] setRemoteDescription(answer) failed:", e);
      });
  }

  function handleIce(fromUid, candidate) {
    var peer = _peers[fromUid];
    if (!peer) return;
    if (!peer.remoteSet) {
      // Buffer until remote description is set
      peer.iceBuf.push(candidate);
    } else {
      try {
        peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch(e) {
        console.warn("[crow-webrtc] addIceCandidate failed:", e);
      }
    }
  }

  // ─── Group membership changes ───
  function onGroupUpdate(members, yourUid) {
    if (yourUid) _myUid = yourUid;
    if (!_myUid) return;

    var prevSet = {};
    for (var i = 0; i < _lastMembers.length; i++) prevSet[_lastMembers[i]] = true;

    var currSet = {};
    for (var i = 0; i < members.length; i++) currSet[members[i]] = true;

    // New members: send offers (only if I was already in the group)
    if (_lastMembers.length > 0) {
      for (var i = 0; i < members.length; i++) {
        var uid = members[i];
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

    _lastMembers = members.slice();
    updateUI();
  }

  // ─── UI: floating mic button ───
  var _btn = null;
  var _badge = null;
  var _statusText = null;

  function createUI() {
    _btn = document.createElement("button");
    _btn.id = "crow-webrtc-btn";
    _btn.title = "Voice Chat";
    _btn.style.cssText = "position:fixed;bottom:58px;right:70px;z-index:9999;background:rgba(15,15,23,0.7);border:1px solid rgba(34,197,94,0.4);border-radius:10px;color:#22c55e;padding:8px 12px;cursor:pointer;backdrop-filter:blur(8px);transition:opacity 0.3s,border-color 0.15s;opacity:0;pointer-events:none;display:flex;align-items:center;gap:6px;font-size:12px;font-family:'DM Sans',sans-serif;";

    // People-group badge (distinguishes from native AI mic)
    var svgNS = "http://www.w3.org/2000/svg";
    var groupSvg = document.createElementNS(svgNS, "svg");
    groupSvg.setAttribute("width", "14"); groupSvg.setAttribute("height", "14");
    groupSvg.setAttribute("viewBox", "0 0 24 24"); groupSvg.setAttribute("fill", "none");
    groupSvg.setAttribute("stroke", "currentColor"); groupSvg.setAttribute("stroke-width", "2");
    groupSvg.setAttribute("stroke-linecap", "round"); groupSvg.setAttribute("stroke-linejoin", "round");
    var gp1 = document.createElementNS(svgNS, "path");
    gp1.setAttribute("d", "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2");
    var gc1 = document.createElementNS(svgNS, "circle");
    gc1.setAttribute("cx", "9"); gc1.setAttribute("cy", "7"); gc1.setAttribute("r", "4");
    var gp2 = document.createElementNS(svgNS, "path");
    gp2.setAttribute("d", "M23 21v-2a4 4 0 0 0-3-3.87");
    var gp3 = document.createElementNS(svgNS, "path");
    gp3.setAttribute("d", "M16 3.13a4 4 0 0 1 0 7.75");
    groupSvg.appendChild(gp1); groupSvg.appendChild(gc1); groupSvg.appendChild(gp2); groupSvg.appendChild(gp3);
    _btn.appendChild(groupSvg);

    // Mic SVG icon
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "16"); svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "2");
    var path1 = document.createElementNS(svgNS, "path");
    path1.setAttribute("d", "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z");
    var path2 = document.createElementNS(svgNS, "path");
    path2.setAttribute("d", "M19 10v2a7 7 0 0 1-14 0v-2");
    var line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", "12"); line.setAttribute("y1", "19");
    line.setAttribute("x2", "12"); line.setAttribute("y2", "23");
    var line2 = document.createElementNS(svgNS, "line");
    line2.setAttribute("x1", "8"); line2.setAttribute("y1", "23");
    line2.setAttribute("x2", "16"); line2.setAttribute("y2", "23");
    svg.appendChild(path1); svg.appendChild(path2); svg.appendChild(line); svg.appendChild(line2);
    _btn.appendChild(svg);

    _badge = document.createElement("span");
    _badge.style.cssText = "font-weight:600;font-size:11px;";
    _badge.textContent = "";
    _btn.appendChild(_badge);

    _statusText = document.createElement("span");
    _statusText.style.cssText = "font-size:10px;color:#a8a29e;";
    _btn.appendChild(_statusText);

    _btn.onclick = toggleMute;
    document.body.appendChild(_btn);
  }

  function updateUI() {
    if (!_btn) return;

    var activePeers = 0;
    var uids = Object.keys(_peers);
    for (var i = 0; i < uids.length; i++) {
      var state = _peers[uids[i]].pc.iceConnectionState;
      if (state === "connected" || state === "completed") activePeers++;
    }

    var totalMembers = _lastMembers.length;
    var show = totalMembers > 1;

    _btn.style.opacity = show ? "1" : "0";
    _btn.style.pointerEvents = show ? "auto" : "none";

    if (_muted) {
      _btn.style.borderColor = "rgba(239,68,68,0.4)";
      _btn.style.color = "#ef4444";
      _badge.textContent = "Muted";
    } else {
      _btn.style.borderColor = "rgba(34,197,94,0.4)";
      _btn.style.color = "#22c55e";
      _badge.textContent = activePeers > 0 ? activePeers + " peer" + (activePeers > 1 ? "s" : "") : "";
    }

    // Status for pending/failed connections
    var pending = uids.length - activePeers;
    if (pending > 0 && activePeers === 0 && uids.length > 0) {
      _statusText.textContent = "connecting...";
    } else {
      _statusText.textContent = "";
    }
  }

  function toggleMute() {
    _muted = !_muted;

    // Update all cloned tracks in peer connections
    var uids = Object.keys(_peers);
    for (var i = 0; i < uids.length; i++) {
      var senders = _peers[uids[i]].pc.getSenders();
      for (var j = 0; j < senders.length; j++) {
        if (senders[j].track && senders[j].track.kind === "audio") {
          senders[j].track.enabled = !_muted;
        }
      }
    }

    sendMuteState();
    updateUI();
  }

  // ─── Initialize ───
  createUI();

  // Register with shared WS bridge
  window.CrowWS = window.CrowWS || { handlers: [] };
  window.CrowWS.handlers.push(function(d) {
    // When calls bundle is active, companion WebRTC is disabled (CrowCalls takes over)
    if (window.CrowWebRTC && window.CrowWebRTC._disabled) return;

    // Group membership changed
    if (d.type === "group-update" && d.members) {
      onGroupUpdate(d.members, d.your_uid);
    }

    // WebRTC signaling from a peer
    if (d.type === "webrtc-signal" && d.from_uid) {
      if (d.signal_type === "offer" && d.sdp) {
        handleOffer(d.from_uid, d.sdp);
      } else if (d.signal_type === "answer" && d.sdp) {
        handleAnswer(d.from_uid, d.sdp);
      } else if (d.signal_type === "ice" && d.candidate) {
        handleIce(d.from_uid, d.candidate);
      }
    }

    // Peer mute state
    if (d.type === "webrtc-mute" && d.from_uid) {
      console.log("[crow-webrtc]", d.from_uid, d.muted ? "muted" : "unmuted");
    }
  });

  // ─── Expose API for voice panel (additive, preserves gatewayUrl/stunUrl) ───
  window.CrowWebRTC = window.CrowWebRTC || {};
  window.CrowWebRTC.getPeerStream = function(uid) {
    var peer = _peers[uid];
    return (peer && peer.audioEl && peer.audioEl.srcObject) ? peer.audioEl.srcObject : null;
  };
  window.CrowWebRTC.getLocalStream = function() { return _localStream; };
  window.CrowWebRTC.getMyUid = function() { return _myUid; };
  window.CrowWebRTC.getPeerUids = function() { return Object.keys(_peers); };
  window.CrowWebRTC.isMuted = function() { return _muted; };

})();
