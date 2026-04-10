/**
 * Crow Remote Avatar — Render Live2D Avatars from Peer DataChannel State
 *
 * When a peer is in "avatar" or "both" mode, this module renders their
 * Live2D avatar locally using state received via DataChannel. Falls back
 * to an animated gradient circle for missing models or low-memory devices.
 *
 * Performance budget is memory-gated by navigator.deviceMemory.
 *
 * Requires: CrowCalls + CrowAvatarSync (both from companion enhancement layer)
 * Exposes: window.CrowRemoteAvatar
 */
(function() {
  "use strict";

  var CANVAS_SIZE = 48;         // px, for voice panel pill avatar
  var LERP_FACTOR = 0.3;        // smooth network jitter
  var CLEANUP_DELAY = 500;      // ms, delay before destroying on mode change

  // Memory budget: max Live2D instances by device memory
  var MAX_INSTANCES_HIGH = 3;   // >= 8GB
  var MAX_INSTANCES_MID = 1;    // 4-8GB
  var MAX_INSTANCES_LOW = 0;    // < 4GB (all fallback)

  var _instances = {};          // uid → { app, model, canvas, smoothedParams, fallback }
  var _aiInstances = {};        // "ai" → same structure for AI avatar
  var _maxInstances = MAX_INSTANCES_MID;
  var _instanceCount = 0;

  // ─── Device capability ───

  function detectMaxInstances() {
    var mem = navigator.deviceMemory || 4;
    if (mem >= 8) return MAX_INSTANCES_HIGH;
    if (mem >= 4) return MAX_INSTANCES_MID;
    return MAX_INSTANCES_LOW;
  }
  _maxInstances = detectMaxInstances();

  // ─── Fallback: Animated Gradient Circle ───
  // For missing models or when Live2D budget is exhausted.

  function createFallbackAvatar(uid, modelId) {
    var canvas = document.createElement("canvas");
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    canvas.className = "crow-remote-avatar";
    canvas.setAttribute("data-avatar-uid", uid);
    canvas.style.cssText = "width:" + CANVAS_SIZE + "px;height:" + CANVAS_SIZE + "px;border-radius:50%;";

    var ctx = canvas.getContext("2d");
    var initial = modelId ? modelId.charAt(0).toUpperCase() : "?";

    var instance = {
      canvas: canvas,
      ctx: ctx,
      initial: initial,
      fallback: true,
      mouthOpen: 0,        // current mouth openness (0-1)
      targetMouth: 0,      // target from DataChannel
      app: null,
      model: null,
      smoothedParams: null,
    };

    // Initial draw
    drawFallback(instance);

    _instances[uid] = instance;
    return instance;
  }

  function drawFallback(inst) {
    var ctx = inst.ctx;
    var w = CANVAS_SIZE;
    var cx = w / 2;

    // Gradient background
    var grad = ctx.createLinearGradient(0, 0, w, w);
    grad.addColorStop(0, "#818cf8");
    grad.addColorStop(1, "#a78bfa");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cx, cx, 0, Math.PI * 2);
    ctx.fill();

    // Initial letter
    ctx.fillStyle = "#fff";
    ctx.font = "bold 18px 'DM Sans', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(inst.initial, cx, cx - 4);

    // Mouth indicator (pulsing bar synced to ParamMouthOpenY)
    var mouthWidth = 12 + inst.mouthOpen * 8;
    var mouthHeight = 2 + inst.mouthOpen * 6;
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.beginPath();
    ctx.ellipse(cx, cx + 12, mouthWidth / 2, mouthHeight / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function updateFallback(uid, params) {
    var inst = _instances[uid];
    if (!inst || !inst.fallback) return;

    inst.targetMouth = (params && params.ParamMouthOpenY) || 0;
    // Lerp mouth
    inst.mouthOpen += (inst.targetMouth - inst.mouthOpen) * LERP_FACTOR;

    drawFallback(inst);
  }

  // ─── Live2D Instance ───
  // Creates a PIXI application with a Live2D model loaded via pixi-live2d-display.
  // Only works inside the companion's OLV frontend (which has PIXI + pixi-live2d-display loaded).

  function createLive2DAvatar(uid, modelId) {
    // Check budget
    if (_instanceCount >= _maxInstances) {
      return createFallbackAvatar(uid, modelId);
    }

    // Check if PIXI is available (we're inside OLV)
    if (!window.PIXI || !window.PIXI.Application) {
      return createFallbackAvatar(uid, modelId);
    }

    var canvas = document.createElement("canvas");
    canvas.width = CANVAS_SIZE * 2;  // render at 2x for clarity
    canvas.height = CANVAS_SIZE * 2;
    canvas.className = "crow-remote-avatar";
    canvas.setAttribute("data-avatar-uid", uid);
    canvas.style.cssText = "width:" + CANVAS_SIZE + "px;height:" + CANVAS_SIZE + "px;border-radius:50%;object-fit:cover;";

    var app;
    try {
      app = new window.PIXI.Application({
        view: canvas,
        width: CANVAS_SIZE * 2,
        height: CANVAS_SIZE * 2,
        backgroundAlpha: 0,
        autoStart: true,
      });
    } catch(e) {
      return createFallbackAvatar(uid, modelId);
    }

    var instance = {
      canvas: canvas,
      app: app,
      model: null,
      fallback: false,
      smoothedParams: null,
    };
    _instances[uid] = instance;
    _instanceCount++;

    // Try to load the model
    // Models are served from /app/live2d-models/ inside the companion container
    var modelPath = "/app/live2d-models/" + modelId + "/" + modelId + ".model3.json";
    // Also try model.json (Live2D 2.x format)
    var modelPathAlt = "/app/live2d-models/" + modelId + "/" + modelId + ".model.json";

    loadModel(app, instance, modelPath, modelPathAlt, uid, modelId);

    return instance;
  }

  function loadModel(app, instance, path, altPath, uid, modelId) {
    // pixi-live2d-display's Live2DModel.from() loads model from URL
    if (!window.PIXI.live2d || !window.PIXI.live2d.Live2DModel) {
      // pixi-live2d-display not loaded; fallback
      destroyInstance(uid);
      createFallbackAvatar(uid, modelId);
      return;
    }

    window.PIXI.live2d.Live2DModel.from(path).then(function(model) {
      setupModel(app, instance, model);
    }).catch(function() {
      // Try alt path
      window.PIXI.live2d.Live2DModel.from(altPath).then(function(model) {
        setupModel(app, instance, model);
      }).catch(function() {
        // Model not found; convert to fallback
        destroyInstance(uid);
        createFallbackAvatar(uid, modelId);
      });
    });
  }

  function setupModel(app, instance, model) {
    // Scale model to fit canvas
    var scale = (CANVAS_SIZE * 2) / Math.max(model.width, model.height);
    model.scale.set(scale * 0.8);
    model.x = (CANVAS_SIZE * 2 - model.width * scale * 0.8) / 2;
    model.y = (CANVAS_SIZE * 2 - model.height * scale * 0.8) / 2;

    app.stage.addChild(model);
    instance.model = model;
  }

  // ─── Apply Remote State ───

  function applyRemoteState(uid, data) {
    var inst = _instances[uid];
    if (!inst) return;

    if (inst.fallback) {
      updateFallback(uid, data.params);
      return;
    }

    if (!inst.model) return;

    var params = data.params;
    if (!params) return;

    // Lerp smoothing
    if (!inst.smoothedParams) {
      inst.smoothedParams = {};
      for (var key in params) {
        if (params.hasOwnProperty(key)) inst.smoothedParams[key] = params[key];
      }
    } else {
      for (var key in params) {
        if (params.hasOwnProperty(key)) {
          var prev = inst.smoothedParams[key] !== undefined ? inst.smoothedParams[key] : params[key];
          inst.smoothedParams[key] = prev + (params[key] - prev) * LERP_FACTOR;
        }
      }
    }

    // Apply to model
    try {
      var coreModel = inst.model.internalModel.coreModel;
      for (var key in inst.smoothedParams) {
        if (inst.smoothedParams.hasOwnProperty(key)) {
          coreModel.setParameterValueById(key, inst.smoothedParams[key]);
        }
      }
    } catch(e) {}

    // Apply motion/expression changes
    try {
      if (data.motion && inst._lastMotion !== data.motion) {
        inst._lastMotion = data.motion;
        inst.model.motion(data.motion);
      }
      if (data.expression && inst._lastExpression !== data.expression) {
        inst._lastExpression = data.expression;
        inst.model.expression(data.expression);
      }
    } catch(e) {}
  }

  // ─── Instance Lifecycle ───

  function destroyInstance(uid) {
    var inst = _instances[uid];
    if (!inst) return;

    if (inst.app) {
      try { inst.app.destroy(true); } catch(e) {}
      if (!inst.fallback) _instanceCount = Math.max(0, _instanceCount - 1);
    }
    if (inst.canvas && inst.canvas.parentNode) {
      inst.canvas.parentNode.removeChild(inst.canvas);
    }
    delete _instances[uid];
  }

  function destroyAll() {
    var uids = Object.keys(_instances);
    for (var i = 0; i < uids.length; i++) destroyInstance(uids[i]);
    _instanceCount = 0;
  }

  // ─── Voice Panel Integration ───
  // Place avatar canvases inside peer pills in the calls voice panel.

  function placeAvatarInPill(uid) {
    var inst = _instances[uid];
    if (!inst || !inst.canvas) return;

    var panel = document.getElementById("crow-calls-panel");
    if (!panel) return;

    var pill = panel.querySelector('[data-uid="' + uid + '"]');
    if (!pill) return;

    // Remove existing avatar circle, replace with canvas
    var existingAvatar = pill.querySelector(".vp-avatar");
    var existingBadge = pill.querySelector(".vp-avatar-badge");
    if (existingBadge) existingBadge.remove();

    if (existingAvatar) {
      existingAvatar.style.display = "none";
    }

    // Don't add duplicate
    if (pill.querySelector(".crow-remote-avatar")) return;

    inst.canvas.style.cssText += "flex-shrink:0;";
    // Insert before the name element
    var nameEl = pill.querySelector(".vp-name");
    if (nameEl) {
      pill.insertBefore(inst.canvas, nameEl);
    } else {
      pill.appendChild(inst.canvas);
    }
  }

  /**
   * Restore the original avatar circle when leaving avatar mode.
   */
  function removeAvatarFromPill(uid) {
    var panel = document.getElementById("crow-calls-panel");
    if (!panel) return;

    var pill = panel.querySelector('[data-uid="' + uid + '"]');
    if (!pill) return;

    var remoteCanvas = pill.querySelector(".crow-remote-avatar");
    if (remoteCanvas) remoteCanvas.remove();

    var existingAvatar = pill.querySelector(".vp-avatar");
    if (existingAvatar) {
      existingAvatar.style.display = "flex";
    }
  }

  // ─── Event Wiring ───
  // Called by inject-call-enhancements.sh after all scripts are loaded.

  function wireEvents() {
    if (!window.CrowCalls || !window.CrowAvatarSync) return;

    // Listen for remote avatar state and apply to instances
    window.CrowAvatarSync.onAnyRemoteState(function(uid, data) {
      var inst = _instances[uid];

      // Create instance on first state message if peer is in avatar/both mode
      if (!inst) {
        var peerMode = window.CrowCalls.getPeerRepresentationMode(uid);
        if (peerMode !== "avatar" && peerMode !== "both" && data.source !== "ai") return;

        var actualUid = data.source === "ai" ? "ai" : uid;
        if (_instances[actualUid]) {
          applyRemoteState(actualUid, data);
          return;
        }

        if (_maxInstances > 0 && _instanceCount < _maxInstances) {
          createLive2DAvatar(actualUid, data.modelId);
        } else {
          createFallbackAvatar(actualUid, data.modelId);
        }

        // Place in pill after a tick (DOM may not be ready)
        setTimeout(function() { placeAvatarInPill(actualUid); }, 100);
        return;
      }

      applyRemoteState(uid, data);
    });

    // Clean up when peer leaves
    window.CrowCalls.on("peer-left", function(data) {
      setTimeout(function() {
        destroyInstance(data.uid);
        removeAvatarFromPill(data.uid);
      }, CLEANUP_DELAY);
    });

    // Clean up when peer changes mode to audio/camera
    window.CrowCalls.on("peer-representation", function(data) {
      if (data.mode !== "avatar" && data.mode !== "both") {
        setTimeout(function() {
          destroyInstance(data.uid);
          removeAvatarFromPill(data.uid);
        }, CLEANUP_DELAY);
      }
    });

    // Clean up all on disconnect
    window.CrowCalls.on("disconnected", function() {
      destroyAll();
    });
  }

  // ─── Public API ───

  window.CrowRemoteAvatar = {
    wireEvents: wireEvents,
    destroyAll: destroyAll,

    getInstance: function(uid) { return _instances[uid] || null; },
    getInstanceCount: function() { return _instanceCount; },
    getMaxInstances: function() { return _maxInstances; },

    /**
     * Manually create an avatar for a uid (used by integration layer).
     */
    createAvatar: function(uid, modelId) {
      if (_instances[uid]) return _instances[uid];
      if (_maxInstances > 0 && _instanceCount < _maxInstances) {
        return createLive2DAvatar(uid, modelId);
      }
      return createFallbackAvatar(uid, modelId);
    },

    /**
     * Manually place an avatar canvas in a peer pill.
     */
    placeInPill: function(uid) { placeAvatarInPill(uid); },

    /**
     * Remove an avatar from a peer pill and destroy the instance.
     */
    removeFromPill: function(uid) {
      removeAvatarFromPill(uid);
      destroyInstance(uid);
    },
  };

})();
