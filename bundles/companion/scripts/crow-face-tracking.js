/**
 * Crow Face Tracking — MediaPipe Face Mesh to Live2D
 *
 * Optional face tracking that drives the Live2D avatar's expressions
 * from the user's camera. Built from scratch using MediaPipe Face Mesh
 * (468 3D landmarks, runs in browser via WebAssembly).
 *
 * Exposes window.CrowFaceTracking API.
 * Used by Phase 7 (avatar sync) to broadcast tracked params to peers.
 */
(function() {
  "use strict";

  // MediaPipe CDN for Face Mesh WASM + model files
  var MEDIAPIPE_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/";

  var TARGET_FPS = 15;          // process every other frame at 30fps camera
  var LERP_FACTOR = 0.4;        // smoothing factor (0 = no change, 1 = instant)
  var SLOW_FRAME_MS = 50;       // if processing takes > 50ms, reduce to 10fps
  var UNLOAD_TIMEOUT = 60000;   // unload model after 60s of inactivity
  var MIN_DEVICE_MEMORY = 4;    // GB — disable face tracking on low-memory devices

  var _enabled = false;
  var _faceMesh = null;
  var _videoEl = null;
  var _stream = null;           // camera stream (may share with CrowCalls)
  var _ownStream = false;       // true if we created the stream (need to stop it)
  var _animFrame = null;
  var _lastParams = null;       // latest Live2D params
  var _smoothedParams = null;   // lerp-smoothed params
  var _callbacks = [];          // onParamsUpdate listeners
  var _loading = false;
  var _frameInterval = Math.round(1000 / TARGET_FPS);
  var _lastFrameTime = 0;
  var _unloadTimer = null;
  var _slowFrameCount = 0;
  var _model = null;            // OLV Live2D model reference (cached)

  // ─── Device capability check ───
  function canUseFaceTracking() {
    var mem = navigator.deviceMemory || 4;
    return mem >= MIN_DEVICE_MEMORY;
  }

  // ─── MediaPipe Face Mesh loading ───
  // Lazy-loaded on first toggle. ~2MB WASM download, cached by browser.

  function loadFaceMesh() {
    if (_faceMesh) return Promise.resolve(_faceMesh);
    if (_loading) return new Promise(function(res) {
      var check = setInterval(function() {
        if (_faceMesh) { clearInterval(check); res(_faceMesh); }
      }, 100);
    });

    _loading = true;
    emit("loading", { status: "downloading" });

    return new Promise(function(resolve, reject) {
      // Dynamic import of MediaPipe Face Mesh
      var script = document.createElement("script");
      script.src = MEDIAPIPE_CDN + "face_mesh.js";
      script.onload = function() {
        try {
          /* global FaceMesh */
          var fm = new window.FaceMesh({
            locateFile: function(file) {
              return MEDIAPIPE_CDN + file;
            },
          });

          fm.setOptions({
            maxNumFaces: 1,
            refineLandmarks: true,     // iris tracking for eye direction
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });

          fm.onResults(function(results) {
            if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
              var landmarks = results.multiFaceLandmarks[0];
              _lastParams = landmarksToLive2D(landmarks);
              _smoothedParams = lerpParams(_smoothedParams, _lastParams, LERP_FACTOR);
              applyToLocalModel(_smoothedParams);
              notifyCallbacks(_smoothedParams);
            }
          });

          fm.initialize().then(function() {
            _faceMesh = fm;
            _loading = false;
            emit("loading", { status: "ready" });
            resolve(fm);
          });
        } catch(e) {
          _loading = false;
          emit("loading", { status: "error", error: e.message });
          reject(e);
        }
      };
      script.onerror = function() {
        _loading = false;
        emit("loading", { status: "error", error: "Failed to load MediaPipe" });
        reject(new Error("Failed to load MediaPipe Face Mesh"));
      };
      document.head.appendChild(script);
    });
  }

  function unloadFaceMesh() {
    if (_faceMesh) {
      try { _faceMesh.close(); } catch(e) {}
      _faceMesh = null;
    }
    _loading = false;
  }

  // ─── Camera stream ───
  // Shares with CrowCalls if available, otherwise creates its own.

  function acquireCamera() {
    // Try to reuse CrowCalls video stream
    if (window.CrowCalls && window.CrowCalls.getLocalVideoStream()) {
      _stream = window.CrowCalls.getLocalVideoStream();
      _ownStream = false;
      return Promise.resolve(_stream);
    }

    // Create our own low-res stream for face tracking only
    _ownStream = true;
    return navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, frameRate: 15 },
    }).then(function(stream) {
      _stream = stream;
      return stream;
    });
  }

  function releaseCamera() {
    if (_ownStream && _stream) {
      _stream.getTracks().forEach(function(t) { t.stop(); });
    }
    _stream = null;
    _ownStream = false;
  }

  // ─── Face landmark indices ───
  // MediaPipe Face Mesh 468 landmarks. Key indices for Live2D mapping.

  // Nose tip (for head rotation reference)
  var NOSE_TIP = 1;
  var FOREHEAD = 10;
  var CHIN = 152;
  var LEFT_EAR = 234;
  var RIGHT_EAR = 454;

  // Eyes
  var LEFT_EYE_TOP = 159;
  var LEFT_EYE_BOTTOM = 145;
  var LEFT_EYE_INNER = 133;
  var LEFT_EYE_OUTER = 33;
  var RIGHT_EYE_TOP = 386;
  var RIGHT_EYE_BOTTOM = 374;
  var RIGHT_EYE_INNER = 362;
  var RIGHT_EYE_OUTER = 263;

  // Iris (refined landmarks, indices 468-477)
  var LEFT_IRIS_CENTER = 468;
  var RIGHT_IRIS_CENTER = 473;

  // Mouth
  var MOUTH_TOP = 13;
  var MOUTH_BOTTOM = 14;
  var MOUTH_LEFT = 61;
  var MOUTH_RIGHT = 291;
  var UPPER_LIP_TOP = 0;
  var LOWER_LIP_BOTTOM = 17;

  // Eyebrows
  var LEFT_BROW_INNER = 107;
  var LEFT_BROW_OUTER = 70;
  var LEFT_BROW_MID = 105;
  var RIGHT_BROW_INNER = 336;
  var RIGHT_BROW_OUTER = 300;
  var RIGHT_BROW_MID = 334;

  // ─── Landmark math helpers ───

  function dist(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function dist2d(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function remap(val, inMin, inMax, outMin, outMax) {
    return outMin + (outMax - outMin) * clamp((val - inMin) / (inMax - inMin), 0, 1);
  }

  // ─── Landmark → Live2D parameter mapping ───

  function landmarksToLive2D(lm) {
    return {
      ParamAngleX: calculateHeadYaw(lm),
      ParamAngleY: calculateHeadPitch(lm),
      ParamAngleZ: calculateHeadRoll(lm),
      ParamEyeLOpen: calculateEyeOpenness(lm, "left"),
      ParamEyeROpen: calculateEyeOpenness(lm, "right"),
      ParamEyeBallX: calculateEyeDirection(lm, "x"),
      ParamEyeBallY: calculateEyeDirection(lm, "y"),
      ParamMouthOpenY: calculateMouthOpenness(lm),
      ParamMouthForm: calculateMouthSmile(lm),
      ParamBrowLY: calculateBrowPosition(lm, "left"),
      ParamBrowRY: calculateBrowPosition(lm, "right"),
    };
  }

  function calculateHeadYaw(lm) {
    // Yaw: horizontal rotation based on nose-to-ear distances
    var noseToLeft = dist2d(lm[NOSE_TIP], lm[LEFT_EAR]);
    var noseToRight = dist2d(lm[NOSE_TIP], lm[RIGHT_EAR]);
    var ratio = (noseToRight - noseToLeft) / (noseToRight + noseToLeft);
    return remap(ratio, -0.3, 0.3, -30, 30);
  }

  function calculateHeadPitch(lm) {
    // Pitch: vertical rotation based on nose-to-forehead vs nose-to-chin
    var noseToForehead = dist2d(lm[NOSE_TIP], lm[FOREHEAD]);
    var noseToChin = dist2d(lm[NOSE_TIP], lm[CHIN]);
    var ratio = (noseToChin - noseToForehead) / (noseToChin + noseToForehead);
    return remap(ratio, -0.2, 0.4, -30, 30);
  }

  function calculateHeadRoll(lm) {
    // Roll: tilt based on ear-to-ear angle
    var dx = lm[RIGHT_EAR].x - lm[LEFT_EAR].x;
    var dy = lm[RIGHT_EAR].y - lm[LEFT_EAR].y;
    var angle = Math.atan2(dy, dx) * (180 / Math.PI);
    return clamp(angle, -30, 30);
  }

  function calculateEyeOpenness(lm, side) {
    var top, bottom, inner, outer;
    if (side === "left") {
      top = lm[LEFT_EYE_TOP]; bottom = lm[LEFT_EYE_BOTTOM];
      inner = lm[LEFT_EYE_INNER]; outer = lm[LEFT_EYE_OUTER];
    } else {
      top = lm[RIGHT_EYE_TOP]; bottom = lm[RIGHT_EYE_BOTTOM];
      inner = lm[RIGHT_EYE_INNER]; outer = lm[RIGHT_EYE_OUTER];
    }
    var eyeHeight = dist2d(top, bottom);
    var eyeWidth = dist2d(inner, outer);
    var ratio = eyeHeight / (eyeWidth || 0.001);
    // Typical open eye ratio ~0.25-0.35, closed ~0.05-0.1
    return remap(ratio, 0.08, 0.32, 0, 1);
  }

  function calculateEyeDirection(lm, axis) {
    // Iris-based eye direction (requires refineLandmarks: true)
    if (!lm[LEFT_IRIS_CENTER] || !lm[RIGHT_IRIS_CENTER]) return 0;

    if (axis === "x") {
      // Horizontal: iris position relative to eye corners
      var leftIris = lm[LEFT_IRIS_CENTER];
      var leftInner = lm[LEFT_EYE_INNER];
      var leftOuter = lm[LEFT_EYE_OUTER];
      var rightIris = lm[RIGHT_IRIS_CENTER];
      var rightInner = lm[RIGHT_EYE_INNER];
      var rightOuter = lm[RIGHT_EYE_OUTER];

      var leftRatio = (leftIris.x - leftOuter.x) / (leftInner.x - leftOuter.x || 0.001);
      var rightRatio = (rightIris.x - rightOuter.x) / (rightInner.x - rightOuter.x || 0.001);
      var avgRatio = (leftRatio + rightRatio) / 2;
      return remap(avgRatio, 0.3, 0.7, -1, 1);
    } else {
      // Vertical: iris position relative to eye top/bottom
      var leftIris = lm[LEFT_IRIS_CENTER];
      var leftTop = lm[LEFT_EYE_TOP];
      var leftBottom = lm[LEFT_EYE_BOTTOM];
      var rightIris = lm[RIGHT_IRIS_CENTER];
      var rightTop = lm[RIGHT_EYE_TOP];
      var rightBottom = lm[RIGHT_EYE_BOTTOM];

      var leftRatio = (leftIris.y - leftTop.y) / (leftBottom.y - leftTop.y || 0.001);
      var rightRatio = (rightIris.y - rightTop.y) / (rightBottom.y - rightTop.y || 0.001);
      var avgRatio = (leftRatio + rightRatio) / 2;
      return remap(avgRatio, 0.3, 0.7, -1, 1);
    }
  }

  function calculateMouthOpenness(lm) {
    var mouthHeight = dist2d(lm[MOUTH_TOP], lm[MOUTH_BOTTOM]);
    var mouthWidth = dist2d(lm[MOUTH_LEFT], lm[MOUTH_RIGHT]);
    var ratio = mouthHeight / (mouthWidth || 0.001);
    // Closed mouth ratio ~0.05, open ~0.4+
    return remap(ratio, 0.05, 0.45, 0, 1);
  }

  function calculateMouthSmile(lm) {
    // Smile: mouth corner height relative to mouth center
    var mouthCenter = (lm[MOUTH_TOP].y + lm[MOUTH_BOTTOM].y) / 2;
    var leftCornerY = lm[MOUTH_LEFT].y;
    var rightCornerY = lm[MOUTH_RIGHT].y;
    var avgCornerY = (leftCornerY + rightCornerY) / 2;
    // Corners above center = smile (negative Y in screen coords)
    var diff = mouthCenter - avgCornerY;
    // Also factor in mouth width: wider = more smile
    var mouthWidth = dist2d(lm[MOUTH_LEFT], lm[MOUTH_RIGHT]);
    var faceWidth = dist2d(lm[LEFT_EAR], lm[RIGHT_EAR]);
    var widthRatio = mouthWidth / (faceWidth || 0.001);
    var widthScore = remap(widthRatio, 0.25, 0.4, -0.5, 1);
    var heightScore = remap(diff, -0.01, 0.02, -1, 1);
    return clamp((heightScore + widthScore) / 2, -1, 1);
  }

  function calculateBrowPosition(lm, side) {
    var browMid, eyeTop;
    if (side === "left") {
      browMid = lm[LEFT_BROW_MID]; eyeTop = lm[LEFT_EYE_TOP];
    } else {
      browMid = lm[RIGHT_BROW_MID]; eyeTop = lm[RIGHT_EYE_TOP];
    }
    var browDist = dist2d(browMid, eyeTop);
    var faceHeight = dist2d(lm[FOREHEAD], lm[CHIN]);
    var ratio = browDist / (faceHeight || 0.001);
    // Neutral ~0.04, raised ~0.06+, furrowed ~0.025
    return remap(ratio, 0.025, 0.065, -1, 1);
  }

  // ─── Lerp smoothing ───

  function lerpParams(prev, next, factor) {
    if (!prev) return next;
    var result = {};
    for (var key in next) {
      if (next.hasOwnProperty(key)) {
        result[key] = prev[key] !== undefined
          ? prev[key] + (next[key] - prev[key]) * factor
          : next[key];
      }
    }
    return result;
  }

  // ─── Apply to Live2D model ───
  // Accesses OLV's Pixi app and model instance via internal API.
  // Wrapped in try/catch since these are internal APIs that may change.

  function findLive2DModel() {
    if (_model) return _model;
    try {
      // OLV renders the Live2D model via pixi-live2d-display
      // The model is attached to the Pixi application's stage
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

  // Live2D parameter name → index mapping (built on first use)
  var _paramIndexMap = null;

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

  function applyToLocalModel(params) {
    var model = findLive2DModel();
    if (!model) return;

    try {
      var coreModel = model.internalModel.coreModel;
      buildParamIndexMap(coreModel);
      if (!_paramIndexMap) return;

      for (var key in params) {
        if (params.hasOwnProperty(key) && _paramIndexMap[key] !== undefined) {
          coreModel.setParameterValueById(key, params[key]);
        }
      }
    } catch(e) {
      // Internal API may not be available; non-fatal
    }
  }

  // ─── Processing loop ───

  function processFrame() {
    if (!_enabled || !_faceMesh || !_videoEl) return;

    var now = performance.now();
    if (now - _lastFrameTime < _frameInterval) {
      _animFrame = requestAnimationFrame(processFrame);
      return;
    }

    var startTime = now;
    _lastFrameTime = now;

    _faceMesh.send({ image: _videoEl }).then(function() {
      var elapsed = performance.now() - startTime;

      // Performance guardrail: slow frames → reduce FPS
      if (elapsed > SLOW_FRAME_MS) {
        _slowFrameCount++;
        if (_slowFrameCount > 3) {
          _frameInterval = 100; // drop to 10fps
          console.warn("[crow-face-tracking] slow processing, reducing to 10fps");
        }
      } else {
        _slowFrameCount = Math.max(0, _slowFrameCount - 1);
      }

      if (_enabled) {
        _animFrame = requestAnimationFrame(processFrame);
      }
    }).catch(function() {
      if (_enabled) {
        _animFrame = requestAnimationFrame(processFrame);
      }
    });
  }

  // ─── Callback management ───

  function notifyCallbacks(params) {
    for (var i = 0; i < _callbacks.length; i++) {
      try { _callbacks[i](params); } catch(e) {}
    }
  }

  // ─── Event emitter (minimal) ───
  var _handlers = {};
  function emit(type, data) {
    var list = _handlers[type];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](data); } catch(e) {}
    }
  }

  // ─── Toggle UI injection ───
  // Adds a face tracking toggle button near the companion's camera controls.

  var _toggleBtn = null;

  function createToggleUI() {
    if (_toggleBtn) return;

    _toggleBtn = document.createElement("button");
    _toggleBtn.id = "crow-face-tracking-toggle";
    _toggleBtn.title = "Toggle face tracking";
    _toggleBtn.style.cssText =
      "position:fixed;bottom:80px;right:12px;z-index:500;width:36px;height:36px;" +
      "border-radius:50%;border:1px solid rgba(61,61,77,0.5);background:rgba(15,15,23,0.8);" +
      "backdrop-filter:blur(8px);cursor:pointer;display:flex;align-items:center;" +
      "justify-content:center;font-size:16px;color:#a8a29e;transition:all 0.2s;" +
      "font-family:'DM Sans',system-ui,sans-serif;";
    _toggleBtn.textContent = "\u2728"; // sparkle
    _toggleBtn.onclick = function() {
      window.CrowFaceTracking.toggle();
    };

    document.body.appendChild(_toggleBtn);
  }

  function updateToggleUI() {
    if (!_toggleBtn) return;
    if (_enabled) {
      _toggleBtn.style.borderColor = "rgba(99,102,241,0.6)";
      _toggleBtn.style.color = "#818cf8";
      _toggleBtn.style.boxShadow = "0 0 8px rgba(99,102,241,0.2)";
    } else {
      _toggleBtn.style.borderColor = "rgba(61,61,77,0.5)";
      _toggleBtn.style.color = "#a8a29e";
      _toggleBtn.style.boxShadow = "none";
    }
  }

  // ─── Public API ───

  window.CrowFaceTracking = {
    toggle: function() {
      if (!canUseFaceTracking()) {
        console.warn("[crow-face-tracking] disabled on this device (low memory)");
        emit("error", { error: "Face tracking requires at least " + MIN_DEVICE_MEMORY + "GB RAM" });
        return;
      }

      if (_enabled) {
        // Disable
        _enabled = false;
        if (_animFrame) cancelAnimationFrame(_animFrame);
        _animFrame = null;
        releaseCamera();
        _smoothedParams = null;
        _lastParams = null;
        _model = null;
        _paramIndexMap = null;
        updateToggleUI();
        emit("toggled", { enabled: false });

        // Schedule model unload
        _unloadTimer = setTimeout(function() {
          unloadFaceMesh();
        }, UNLOAD_TIMEOUT);

        return;
      }

      // Enable
      if (_unloadTimer) {
        clearTimeout(_unloadTimer);
        _unloadTimer = null;
      }

      loadFaceMesh().then(function() {
        return acquireCamera();
      }).then(function(stream) {
        _videoEl = document.createElement("video");
        _videoEl.srcObject = stream;
        _videoEl.autoplay = true;
        _videoEl.playsInline = true;
        _videoEl.muted = true;
        _videoEl.style.display = "none";
        document.body.appendChild(_videoEl);

        _videoEl.onloadeddata = function() {
          _enabled = true;
          _lastFrameTime = 0;
          _slowFrameCount = 0;
          _frameInterval = Math.round(1000 / TARGET_FPS);
          updateToggleUI();
          emit("toggled", { enabled: true });
          processFrame();
        };
      }).catch(function(e) {
        console.error("[crow-face-tracking] failed to start:", e);
        emit("error", { error: e.message || "Failed to start face tracking" });
      });
    },

    isEnabled: function() { return _enabled; },

    getLatestParams: function() { return _smoothedParams; },

    onParamsUpdate: function(cb) {
      if (typeof cb === "function") _callbacks.push(cb);
    },

    offParamsUpdate: function(cb) {
      _callbacks = _callbacks.filter(function(c) { return c !== cb; });
    },

    on: function(type, fn) {
      if (!_handlers[type]) _handlers[type] = [];
      _handlers[type].push(fn);
    },

    off: function(type, fn) {
      if (!_handlers[type]) return;
      _handlers[type] = _handlers[type].filter(function(h) { return h !== fn; });
    },

    canUse: canUseFaceTracking,
  };

  // ─── Initialize ───
  // Only show toggle UI if device supports it and companion is active
  if (canUseFaceTracking()) {
    // Wait for DOM to be ready
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", createToggleUI);
    } else {
      createToggleUI();
    }
  }

})();
