/**
 * Crow Avatar Sync — Live2D State Capture + DataChannel Broadcast
 *
 * Captures the local Live2D avatar's state at 10fps and sends it to
 * all connected peers via WebRTC DataChannel. State comes from either:
 * - CrowFaceTracking (if face tracking is enabled)
 * - OLV's AI emotion-driven animation (default)
 *
 * Also captures and broadcasts the AI companion's avatar state so
 * peers can see the AI's mouth move during TTS.
 *
 * Requires: CrowCalls (calls bundle) + CrowFaceTracking (companion)
 * Exposes: window.CrowAvatarSync
 */
(function() {
  "use strict";

  var CAPTURE_FPS = 10;
  var CAPTURE_INTERVAL = Math.round(1000 / CAPTURE_FPS);
  var LERP_PARAMS = [
    "ParamAngleX", "ParamAngleY", "ParamAngleZ",
    "ParamEyeLOpen", "ParamEyeROpen",
    "ParamEyeBallX", "ParamEyeBallY",
    "ParamMouthOpenY", "ParamMouthForm",
    "ParamBrowLY", "ParamBrowRY",
  ];

  var _captureTimer = null;
  var _enabled = false;
  var _localState = null;       // last captured state for user avatar
  var _aiState = null;          // last captured state for AI avatar
  var _remoteCallbacks = {};    // uid → [callback, ...]
  var _globalCallbacks = [];    // all remote state updates
  var _model = null;            // cached OLV Live2D model ref
  var _paramIndexMap = null;    // Live2D param name → index
  var _modelId = null;          // current model identifier

  // ─── Live2D Model Access ───
  // Reuses the same pattern as crow-face-tracking.js

  function findLive2DModel() {
    if (_model) return _model;
    try {
      var canvases = document.querySelectorAll("#root canvas");
      for (var i = 0; i < canvases.length; i++) {
        var app = canvases[i].__PIXI_APP__;
        if (app && app.stage && app.stage.children) {
          for (var j = 0; j < app.stage.children.length; j++) {
            var child = app.stage.children[j];
            if (child.internalModel && child.internalModel.coreModel) {
              _model = child;
              return _model;
            }
          }
        }
      }
    } catch(e) {}
    return null;
  }

  function buildParamIndexMap(coreModel) {
    if (_paramIndexMap) return;
    _paramIndexMap = {};
    try {
      var count = coreModel.getParameterCount();
      for (var i = 0; i < count; i++) {
        var id = coreModel.getParameterId(i);
        _paramIndexMap[id] = i;
      }
    } catch(e) {
      _paramIndexMap = null;
    }
  }

  /**
   * Read current Live2D parameter values from the OLV model.
   * Used when face tracking is OFF (AI emotion-driven animation).
   */
  function captureModelState(coreModel) {
    if (!_paramIndexMap) return null;
    var params = {};
    for (var i = 0; i < LERP_PARAMS.length; i++) {
      var name = LERP_PARAMS[i];
      var idx = _paramIndexMap[name];
      if (idx !== undefined) {
        try {
          params[name] = coreModel.getParameterValueById(name);
        } catch(e) {
          // getParameterValueById not available, try by index
          try { params[name] = coreModel.getParameterValue(idx); } catch(e2) {}
        }
      }
    }
    return params;
  }

  /**
   * Try to detect the current model ID from env or model path.
   */
  function detectModelId() {
    if (_modelId) return _modelId;
    // From env (set by entrypoint config injection)
    if (window.CrowCompanionConfig && window.CrowCompanionConfig.avatar) {
      _modelId = window.CrowCompanionConfig.avatar;
      return _modelId;
    }
    // Fallback: try to read from the model's internal data
    var model = findLive2DModel();
    if (model && model.tag) {
      _modelId = model.tag;
      return _modelId;
    }
    _modelId = "unknown";
    return _modelId;
  }

  // ─── State Capture Loop ───

  function captureAndBroadcast() {
    if (!_enabled) return;
    if (!window.CrowCalls || !window.CrowCalls.isConnected()) return;

    var model = findLive2DModel();
    if (!model) return;

    try {
      var coreModel = model.internalModel.coreModel;
      buildParamIndexMap(coreModel);
    } catch(e) { return; }

    // Determine param source
    var params;
    var source = "user";

    if (window.CrowFaceTracking && window.CrowFaceTracking.isEnabled()) {
      // Face tracking active: use tracked params
      params = window.CrowFaceTracking.getLatestParams();
    } else {
      // AI emotion-driven: read from the model directly
      params = captureModelState(model.internalModel.coreModel);
    }

    if (!params) return;

    // Build payload (~100-200 bytes)
    var payload = {
      type: "avatar-state",
      source: source,
      params: params,
      modelId: detectModelId(),
    };

    // Try to capture current expression/motion (if accessible)
    try {
      if (model.internalModel.motionManager) {
        var mg = model.internalModel.motionManager.currentGroup;
        if (mg) payload.motion = mg;
      }
      if (model.internalModel.motionManager && model.internalModel.motionManager.expressionManager) {
        var expr = model.internalModel.motionManager.expressionManager.currentExpressionName;
        if (expr) payload.expression = expr;
      }
    } catch(e) {}

    _localState = payload;

    // Send to all peers via DataChannel
    var peerUids = window.CrowCalls.getPeerUids();
    var json = JSON.stringify(payload);
    for (var i = 0; i < peerUids.length; i++) {
      var dc = window.CrowCalls.getDataChannel(peerUids[i]);
      if (dc && dc.readyState === "open") {
        try { dc.send(json); } catch(e) {}
      }
    }
  }

  /**
   * Capture and broadcast the AI companion's avatar state.
   * Called on a separate timer or piggybacked onto the user capture.
   */
  function captureAiState() {
    if (!_enabled) return;
    if (!window.CrowCalls || !window.CrowCalls.isConnected()) return;

    var model = findLive2DModel();
    if (!model) return;

    try {
      var coreModel = model.internalModel.coreModel;
      buildParamIndexMap(coreModel);
      var params = captureModelState(coreModel);
      if (!params) return;

      var payload = {
        type: "avatar-state",
        source: "ai",
        params: params,
        modelId: detectModelId(),
      };

      try {
        if (model.internalModel.motionManager) {
          var mg = model.internalModel.motionManager.currentGroup;
          if (mg) payload.motion = mg;
        }
      } catch(e) {}

      _aiState = payload;

      var peerUids = window.CrowCalls.getPeerUids();
      var json = JSON.stringify(payload);
      for (var i = 0; i < peerUids.length; i++) {
        var dc = window.CrowCalls.getDataChannel(peerUids[i]);
        if (dc && dc.readyState === "open") {
          try { dc.send(json); } catch(e) {}
        }
      }
    } catch(e) {}
  }

  // ─── DataChannel Message Handling ───

  function handleRemoteState(uid, data) {
    if (data.type !== "avatar-state") return;

    // Notify per-uid callbacks
    var cbs = _remoteCallbacks[uid];
    if (cbs) {
      for (var i = 0; i < cbs.length; i++) {
        try { cbs[i](uid, data); } catch(e) {}
      }
    }

    // Notify global callbacks
    for (var i = 0; i < _globalCallbacks.length; i++) {
      try { _globalCallbacks[i](uid, data); } catch(e) {}
    }
  }

  function handleAvatarInteraction(uid, data) {
    if (data.type !== "avatar-interaction") return;
    // Play the requested gesture motion on our local model
    var model = findLive2DModel();
    if (!model) return;
    try {
      if (data.gesture && model.motion) {
        model.motion(data.gesture);
      }
    } catch(e) {}
  }

  // ─── Lifecycle ───

  function start() {
    if (_enabled) return;
    if (!window.CrowCalls) {
      console.warn("[crow-avatar-sync] CrowCalls not available");
      return;
    }

    _enabled = true;

    // Listen for DataChannel messages from peers
    window.CrowCalls.on("datachannel-message", function(evt) {
      if (evt.data && evt.data.type === "avatar-state") {
        handleRemoteState(evt.uid, evt.data);
      }
      if (evt.data && evt.data.type === "avatar-interaction") {
        handleAvatarInteraction(evt.uid, evt.data);
      }
    });

    // Start capture loop
    _captureTimer = setInterval(function() {
      var mode = window.CrowCalls.getRepresentationMode();
      if (mode === "avatar" || mode === "both") {
        captureAndBroadcast();
      }
      // Always capture AI state when in a call (so peers see AI animate)
      captureAiState();
    }, CAPTURE_INTERVAL);

    console.log("[crow-avatar-sync] started (capture at " + CAPTURE_FPS + "fps)");
  }

  function stop() {
    _enabled = false;
    if (_captureTimer) {
      clearInterval(_captureTimer);
      _captureTimer = null;
    }
    _localState = null;
    _aiState = null;
    _model = null;
    _paramIndexMap = null;
  }

  // ─── Public API ───

  window.CrowAvatarSync = {
    start: start,
    stop: stop,
    isRunning: function() { return _enabled; },

    getLocalState: function() { return _localState; },
    getAiState: function() { return _aiState; },

    /**
     * Register a callback for remote avatar state updates from a specific peer.
     */
    onRemoteState: function(uid, callback) {
      if (!_remoteCallbacks[uid]) _remoteCallbacks[uid] = [];
      _remoteCallbacks[uid].push(callback);
    },

    offRemoteState: function(uid, callback) {
      if (!_remoteCallbacks[uid]) return;
      _remoteCallbacks[uid] = _remoteCallbacks[uid].filter(function(c) { return c !== callback; });
    },

    /**
     * Register a callback for all remote avatar state updates.
     */
    onAnyRemoteState: function(callback) {
      _globalCallbacks.push(callback);
    },

    offAnyRemoteState: function(callback) {
      _globalCallbacks = _globalCallbacks.filter(function(c) { return c !== callback; });
    },

    /**
     * Send an interaction gesture to a peer (stretch goal).
     */
    sendInteraction: function(uid, gesture) {
      if (!window.CrowCalls) return;
      var dc = window.CrowCalls.getDataChannel(uid);
      if (dc && dc.readyState === "open") {
        try {
          dc.send(JSON.stringify({ type: "avatar-interaction", gesture: gesture }));
        } catch(e) {}
      }
    },
  };

})();
