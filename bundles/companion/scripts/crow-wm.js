/**
 * Crow Window Manager — Kiosk Mode
 *
 * Voice-controlled window manager overlay for the AI Companion.
 * Injected into Open-LLM-VTuber's frontend via inject-wm.sh.
 *
 * Architecture:
 * - Listens for tool_call_status WebSocket messages from crow_wm_* tools
 * - Manages floating/fullscreen windows with iframe content
 * - Auto-layouts based on window count
 * - Avatar corners when windows are open
 * - Mobile: fullscreen windows with tab bar switcher
 *
 * References: ~/nova-os/apps/web/src/stores/windowStore.ts
 */
(function() {
  "use strict";

  var MAX_WINDOWS = 6;
  var MOBILE_BREAKPOINT = 768;
  var TITLE_BAR_HEIGHT = 36;
  var TAB_BAR_HEIGHT = 44;
  var SNAP_THRESHOLD = 30;

  // ─── Snap Zones ───
  // Detects which zone the cursor is in based on proximity to screen edges.
  // Returns: "left-half", "right-half", "top-left", "top-right",
  //          "bottom-left", "bottom-right", "maximize", or null
  function detectSnapZone(cx, cy) {
    var w = window.innerWidth, h = window.innerHeight;
    var nearL = cx < SNAP_THRESHOLD;
    var nearR = cx > w - SNAP_THRESHOLD;
    var nearT = cy < SNAP_THRESHOLD;
    var nearB = cy > h - SNAP_THRESHOLD;
    // Corners first (higher priority)
    if (nearT && nearL) return "top-left";
    if (nearT && nearR) return "top-right";
    if (nearB && nearL) return "bottom-left";
    if (nearB && nearR) return "bottom-right";
    // Top edge = maximize
    if (nearT) return "maximize";
    // Side edges = half
    if (nearL) return "left-half";
    if (nearR) return "right-half";
    return null;
  }

  function getSnapPosition(zone) {
    var w = window.innerWidth, h = window.innerHeight;
    var hw = Math.floor(w / 2), hh = Math.floor(h / 2);
    switch (zone) {
      case "maximize":    return { x: 0, y: 0, width: w, height: h };
      case "left-half":   return { x: 0, y: 0, width: hw, height: h };
      case "right-half":  return { x: hw, y: 0, width: w - hw, height: h };
      case "top-left":    return { x: 0, y: 0, width: hw, height: hh };
      case "top-right":   return { x: hw, y: 0, width: w - hw, height: hh };
      case "bottom-left":  return { x: 0, y: hh, width: hw, height: h - hh };
      case "bottom-right": return { x: hw, y: hh, width: w - hw, height: h - hh };
      default: return null;
    }
  }

  // Snap preview overlay (translucent highlight showing where window will land)
  var snapPreview = null;
  function showSnapPreview(zone) {
    if (!zone) { hideSnapPreview(); return; }
    var pos = getSnapPosition(zone);
    if (!pos) { hideSnapPreview(); return; }
    if (!snapPreview) {
      snapPreview = document.createElement("div");
      snapPreview.id = "crow-snap-preview";
      snapPreview.style.cssText = "position:fixed;z-index:299;pointer-events:none;" +
        "background:rgba(99,102,241,0.15);border:2px solid rgba(99,102,241,0.5);" +
        "border-radius:8px;transition:all 0.15s ease;";
      document.body.appendChild(snapPreview);
    }
    snapPreview.style.left = pos.x + "px";
    snapPreview.style.top = pos.y + "px";
    snapPreview.style.width = pos.width + "px";
    snapPreview.style.height = pos.height + "px";
    snapPreview.style.display = "block";
  }
  function hideSnapPreview() {
    if (snapPreview) snapPreview.style.display = "none";
  }

  // ─── Per-app sandbox policies ───
  var APP_SANDBOX = {
    youtube: "allow-scripts allow-same-origin allow-popups allow-presentation",
    browser: "allow-scripts allow-forms allow-popups",
    blog: "allow-scripts allow-same-origin",
    jellyfin: "allow-scripts allow-same-origin",
    romm: "allow-scripts allow-same-origin",
    plex: "allow-scripts allow-same-origin",
    nest: "allow-scripts allow-same-origin",
    videocall: "allow-scripts allow-same-origin",
    content: "",
  };

  var APP_ICONS = {
    youtube: "\u25B6",  // ▶
    browser: "\u2609",  // ☉
    blog: "\u270E",     // ✎
    jellyfin: "\u266B", // ♫
    plex: "\u25B6\u20DD", // ▶⃝
    romm: "\u265F",     // ♟
    nest: "\u2302",     // ⌂
    videocall: "\uD83D\uDCF9", // 📹
    content: "\u2630",  // ☰
  };

  // ─── Helpers ───
  function isMobile() { return window.innerWidth < MOBILE_BREAKPOINT; }
  function genId() { return "wm-" + Date.now() + "-" + Math.random().toString(36).substr(2, 6); }

  // ─── Rich Content Renderer (safe DOM, no innerHTML) ───
  // Accepts a structured array of blocks:
  //   { type: "heading", text: "Title" }
  //   { type: "text", text: "Paragraph text" }
  //   { type: "list", items: ["Item 1", "Item 2"] }
  //   { type: "card", title: "Card Title", body: "Card body text", link: "https://..." }
  //   { type: "divider" }
  function renderRichContent(container, blocks) {
    if (!Array.isArray(blocks)) return;
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var el;
      switch (block.type) {
        case "heading":
          el = document.createElement("h3");
          el.textContent = block.text || "";
          el.style.cssText = "margin:0 0 12px;font-size:16px;font-weight:600;color:#fafaf9;";
          break;
        case "text":
          el = document.createElement("p");
          el.textContent = block.text || "";
          el.style.cssText = "margin:0 0 10px;color:#d6d3d1;";
          break;
        case "list":
          el = document.createElement("ul");
          el.style.cssText = "margin:0 0 12px;padding-left:20px;";
          var items = block.items || [];
          for (var j = 0; j < items.length; j++) {
            var li = document.createElement("li");
            li.textContent = items[j];
            li.style.cssText = "margin:0 0 4px;color:#d6d3d1;";
            el.appendChild(li);
          }
          break;
        case "card":
          el = document.createElement("div");
          el.style.cssText = "margin:0 0 10px;padding:12px;background:rgba(30,30,50,0.6);" +
            "border:1px solid rgba(61,61,77,0.5);border-radius:6px;";
          var cardTitle = document.createElement("div");
          cardTitle.textContent = block.title || "";
          cardTitle.style.cssText = "font-weight:600;color:#fafaf9;margin-bottom:6px;";
          el.appendChild(cardTitle);
          if (block.body) {
            var cardBody = document.createElement("div");
            cardBody.textContent = block.body;
            cardBody.style.cssText = "color:#a8a29e;font-size:13px;";
            el.appendChild(cardBody);
          }
          if (block.link) {
            var cardLink = document.createElement("a");
            cardLink.textContent = block.link;
            cardLink.href = block.link;
            cardLink.target = "_blank";
            cardLink.rel = "noopener";
            cardLink.style.cssText = "color:#6366f1;font-size:12px;margin-top:6px;display:block;text-decoration:none;";
            el.appendChild(cardLink);
          }
          break;
        case "divider":
          el = document.createElement("hr");
          el.style.cssText = "border:none;border-top:1px solid rgba(61,61,77,0.5);margin:12px 0;";
          break;
        default:
          continue;
      }
      container.appendChild(el);
    }
  }

  // ─── Shared WM Control (Phase 4 #4) ───
  var _remoteAction = false; // true while applying an incoming action (prevents echo)

  function broadcastWmAction(action) {
    if (_remoteAction) return;
    if (!window.CrowWS || !window.CrowWS._activeSocket) return;
    try {
      window.CrowWS._activeSocket.send(JSON.stringify({
        type: "crow-wm-action",
        action: action,
      }));
    } catch(e) {}
  }

  function findWindowByKey(appId, url) {
    for (var i = 0; i < store.windows.length; i++) {
      var w = store.windows[i];
      if (w.appId === appId && (!url || w.url === url)) return w;
    }
    return null;
  }

  // ─── Window Store ───
  var store = {
    windows: [],
    nextZIndex: 300,
    focusedId: null,
    _listeners: [],

    onChange: function(fn) { this._listeners.push(fn); },
    _notify: function() {
      for (var i = 0; i < this._listeners.length; i++) this._listeners[i]();
    },

    addWindow: function(opts) {
      if (this.windows.length >= MAX_WINDOWS) return null;
      // If same app is already open, update its URL and focus it
      var existing = this.findByApp(opts.appId);
      if (existing) {
        existing.url = opts.url || existing.url;
        existing.title = opts.title || existing.title;
        this.focusWindow(existing.id);
        // Update the iframe src
        var el = document.getElementById(existing.id);
        if (el) {
          var iframe = el.querySelector("iframe");
          if (iframe && opts.url) iframe.src = opts.url;
          var titleSpan = el.querySelector(".crow-wm-titlebar span");
          if (titleSpan && opts.title) titleSpan.textContent = (APP_ICONS[existing.appId] || "") + " " + opts.title;
        }
        this._notify();
        return existing.id;
      }
      var id = genId();
      var vw = window.innerWidth, vh = window.innerHeight;
      var w = Math.round(vw * 0.7), h = Math.round(vh * 0.7);
      var win = {
        id: id,
        title: opts.title || opts.appId,
        appId: opts.appId || "browser",
        url: opts.url || "",
        richContent: opts.richContent || null,
        sandbox: APP_SANDBOX[opts.appId] || APP_SANDBOX.browser,
        x: Math.round((vw - w) / 2),
        y: Math.round((vh - h) / 2),
        width: w,
        height: h,
        zIndex: this.nextZIndex++,
        maximized: false,
        focused: true,
        error: false,
      };
      // Unfocus all others
      for (var i = 0; i < this.windows.length; i++) this.windows[i].focused = false;
      this.windows.push(win);
      this.focusedId = id;
      this.autoLayout();
      this._notify();
      updateAvatar();
      return id;
    },

    removeWindow: function(id) {
      var win = this.findById(id);
      if (win) broadcastWmAction({ type: "close", appId: win.appId, url: win.url });
      this.windows = this.windows.filter(function(w) { return w.id !== id; });
      if (this.focusedId === id) {
        this.focusedId = this.windows.length ? this.windows[this.windows.length - 1].id : null;
        if (this.focusedId) {
          var w = this.findById(this.focusedId);
          if (w) w.focused = true;
        }
      }
      // Animate out, then remove DOM element
      var el = document.getElementById(id);
      if (el) {
        el.classList.add("crow-wm-closing");
        setTimeout(function() { el.remove(); }, 150);
      }
      this.autoLayout();
      this._notify();
      updateAvatar();
    },

    closeByApp: function(appId) {
      var win = this.findByApp(appId);
      if (win) this.removeWindow(win.id);
    },

    closeFocused: function() {
      if (this.focusedId) this.removeWindow(this.focusedId);
    },

    closeAll: function() {
      broadcastWmAction({ type: "close_all" });
      var ids = this.windows.map(function(w) { return w.id; });
      for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (el) {
          el.classList.add("crow-wm-closing");
          (function(e) { setTimeout(function() { e.remove(); }, 150); })(el);
        }
      }
      this.windows = [];
      this.focusedId = null;
      this._notify();
      updateAvatar();
    },

    focusWindow: function(id) {
      var target = this.findById(id);
      if (target) broadcastWmAction({ type: "focus", appId: target.appId, url: target.url });
      for (var i = 0; i < this.windows.length; i++) {
        var w = this.windows[i];
        w.focused = w.id === id;
        if (w.id === id) {
          w.zIndex = this.nextZIndex++;
          this.focusedId = id;
        }
      }
      this._notify();
    },

    findById: function(id) {
      for (var i = 0; i < this.windows.length; i++) {
        if (this.windows[i].id === id) return this.windows[i];
      }
      return null;
    },

    findByApp: function(appId) {
      for (var i = 0; i < this.windows.length; i++) {
        if (this.windows[i].appId === appId) return this.windows[i];
      }
      return null;
    },

    autoLayout: function() {
      var n = this.windows.length;
      if (n === 0) return;

      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var mobile = isMobile();
      var tabOffset = mobile && n > 0 ? TAB_BAR_HEIGHT : 0;

      if (mobile) {
        // All fullscreen on mobile
        for (var i = 0; i < n; i++) {
          var w = this.windows[i];
          w.x = 0; w.y = tabOffset;
          w.width = vw; w.height = vh - tabOffset;
          w.maximized = true;
        }
      } else if (n === 1) {
        // Single: centered 70%
        var w1 = this.windows[0];
        w1.width = Math.round(vw * 0.7);
        w1.height = Math.round(vh * 0.7);
        w1.x = Math.round((vw - w1.width) / 2);
        w1.y = Math.round((vh - w1.height) / 2);
        w1.maximized = false;
      } else if (n === 2) {
        // Side by side 50/50
        for (var i = 0; i < 2; i++) {
          this.windows[i].x = i * Math.round(vw / 2);
          this.windows[i].y = 0;
          this.windows[i].width = Math.round(vw / 2);
          this.windows[i].height = vh;
          this.windows[i].maximized = false;
        }
      } else if (n === 3) {
        // Primary left 50%, two stacked right
        this.windows[0].x = 0; this.windows[0].y = 0;
        this.windows[0].width = Math.round(vw / 2); this.windows[0].height = vh;
        this.windows[1].x = Math.round(vw / 2); this.windows[1].y = 0;
        this.windows[1].width = Math.round(vw / 2); this.windows[1].height = Math.round(vh / 2);
        this.windows[2].x = Math.round(vw / 2); this.windows[2].y = Math.round(vh / 2);
        this.windows[2].width = Math.round(vw / 2); this.windows[2].height = Math.round(vh / 2);
        for (var i = 0; i < 3; i++) this.windows[i].maximized = false;
      } else {
        // Grid for 4+
        var cols = Math.ceil(Math.sqrt(n));
        var rows = Math.ceil(n / cols);
        var cw = Math.round(vw / cols);
        var rh = Math.round(vh / rows);
        for (var i = 0; i < n; i++) {
          this.windows[i].x = (i % cols) * cw;
          this.windows[i].y = Math.floor(i / cols) * rh;
          this.windows[i].width = cw;
          this.windows[i].height = rh;
          this.windows[i].maximized = false;
        }
      }
    },
  };

  // ─── Avatar Cornering ───
  var avatarStyleEl = null;

  function updateAvatar() {
    var hasWindows = store.windows.length > 0;
    if (hasWindows && !avatarStyleEl) {
      avatarStyleEl = document.createElement("style");
      var size = isMobile() ? (window.innerWidth < 480 ? "0px" : "100px") : "200px";
      var display = window.innerWidth < 480 && hasWindows ? "none" : "block";
      var bottomOffset = "8px";
      avatarStyleEl.textContent =
        "#root canvas { position: fixed !important; bottom: " + bottomOffset + " !important; right: 8px !important; " +
        "width: " + size + " !important; height: " + size + " !important; " +
        "z-index: 299 !important; pointer-events: none !important; " +
        "display: " + display + " !important; border-radius: 12px; }" +
        "#root { pointer-events: none !important; }" +
        "#root > * { pointer-events: auto; }";
      document.head.appendChild(avatarStyleEl);
    } else if (!hasWindows && avatarStyleEl) {
      avatarStyleEl.remove();
      avatarStyleEl = null;
    }
  }

  // ─── Window Renderer ───
  function renderWindow(win) {
    var existing = document.getElementById(win.id);
    if (existing) {
      // Update position/size
      existing.style.left = win.x + "px";
      existing.style.top = win.y + "px";
      existing.style.width = win.width + "px";
      existing.style.height = win.height + "px";
      existing.style.zIndex = String(win.zIndex);
      // On mobile, show only the focused window
      if (isMobile()) {
        existing.style.display = win.id === store.focusedId ? "flex" : "none";
      } else {
        existing.style.display = "flex";
      }
      return;
    }

    var container = document.createElement("div");
    container.id = win.id;
    container.className = "crow-wm-window";
    container.style.cssText =
      "position:fixed;display:flex;flex-direction:column;" +
      "background:#1a1a2e;border:1px solid rgba(61,61,77,0.6);" +
      "border-radius:8px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.5);" +
      "left:" + win.x + "px;top:" + win.y + "px;" +
      "width:" + win.width + "px;height:" + win.height + "px;" +
      "z-index:" + win.zIndex + ";";

    // Title bar (hidden on mobile fullscreen)
    var titleBar = document.createElement("div");
    titleBar.className = "crow-wm-titlebar";
    titleBar.style.cssText =
      "height:" + TITLE_BAR_HEIGHT + "px;background:rgba(15,15,23,0.95);" +
      "border-bottom:1px solid rgba(61,61,77,0.5);display:flex;align-items:center;" +
      "padding:0 8px;gap:8px;flex-shrink:0;cursor:default;user-select:none;" +
      (isMobile() ? "display:none;" : "");

    var titleText = document.createElement("span");
    titleText.style.cssText = "flex:1;font-size:12px;color:#a8a29e;font-family:'DM Sans',sans-serif;" +
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    titleText.textContent = (APP_ICONS[win.appId] || "") + " " + win.title;
    titleBar.appendChild(titleText);

    // Window buttons
    var btnStyle = "background:none;border:none;color:#78716c;cursor:pointer;font-size:14px;padding:4px 6px;border-radius:4px;";
    var closeBtn = document.createElement("button");
    closeBtn.style.cssText = btnStyle;
    closeBtn.textContent = "\u00d7";
    closeBtn.onmouseenter = function() { closeBtn.style.color = "#ef4444"; };
    closeBtn.onmouseleave = function() { closeBtn.style.color = "#78716c"; };
    closeBtn.onclick = function(e) { e.stopPropagation(); store.removeWindow(win.id); };
    titleBar.appendChild(closeBtn);

    container.appendChild(titleBar);

    // Content area
    var content = document.createElement("div");
    content.style.cssText = "flex:1;position:relative;overflow:hidden;";

    if (win.richContent) {
      // Rich content window — structured data rendered via safe DOM methods
      var richDiv = document.createElement("div");
      richDiv.className = "crow-wm-rich-content";
      richDiv.style.cssText = "width:100%;height:100%;overflow:auto;padding:16px;box-sizing:border-box;" +
        "color:#e7e5e4;font-family:'DM Sans',sans-serif;font-size:14px;line-height:1.6;";
      renderRichContent(richDiv, win.richContent);
      content.appendChild(richDiv);
    } else if (win.url) {
      var iframe = document.createElement("iframe");
      iframe.src = win.url;
      iframe.setAttribute("sandbox", win.sandbox);
      iframe.setAttribute("allow", "autoplay; fullscreen; encrypted-media");
      iframe.style.cssText = "width:100%;height:100%;border:none;";
      iframe.onerror = function() {
        content.textContent = "";
        var errDiv = document.createElement("div");
        errDiv.style.cssText = "display:flex;align-items:center;justify-content:center;height:100%;color:#ef4444;font-family:'DM Sans',sans-serif;padding:20px;text-align:center;";
        errDiv.textContent = "Could not load " + win.title;
        content.appendChild(errDiv);
      };
      content.appendChild(iframe);
    }

    container.appendChild(content);

    // Focus on click
    container.addEventListener("pointerdown", function() {
      store.focusWindow(win.id);
    });

    // Desktop drag (title bar only)
    if (!isMobile()) {
      initDrag(titleBar, win);
    }

    var wmContainer = document.getElementById("crow-wm-container");
    if (wmContainer) wmContainer.appendChild(container);
  }

  // ─── Drag Handler (desktop) with snap zones ───
  function initDrag(titleBar, win) {
    var startX, startY, origX, origY, origW, origH, dragging = false;
    var currentZone = null;

    titleBar.style.cursor = "grab";

    titleBar.addEventListener("pointerdown", function(e) {
      if (e.target.tagName === "BUTTON") return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      origX = win.x; origY = win.y;
      origW = win.width; origH = win.height;
      currentZone = null;
      titleBar.style.cursor = "grabbing";
      titleBar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    titleBar.addEventListener("pointermove", function(e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      win.x = Math.max(0, Math.min(window.innerWidth - 100, origX + dx));
      win.y = Math.max(0, Math.min(window.innerHeight - 50, origY + dy));
      var el = document.getElementById(win.id);
      if (el) { el.style.left = win.x + "px"; el.style.top = win.y + "px"; }
      // Snap zone preview
      currentZone = detectSnapZone(e.clientX, e.clientY);
      showSnapPreview(currentZone);
    });

    titleBar.addEventListener("pointerup", function() {
      if (!dragging) return;
      dragging = false;
      titleBar.style.cursor = "grab";
      hideSnapPreview();
      if (currentZone) {
        var snap = getSnapPosition(currentZone);
        if (snap) {
          win.x = snap.x; win.y = snap.y;
          win.width = snap.width; win.height = snap.height;
          var el = document.getElementById(win.id);
          if (el) {
            el.style.left = snap.x + "px"; el.style.top = snap.y + "px";
            el.style.width = snap.width + "px"; el.style.height = snap.height + "px";
          }
        }
        currentZone = null;
      }
      // Broadcast final position to peers
      broadcastWmAction({ type: "move", appId: win.appId, url: win.url, x: win.x, y: win.y, width: win.width, height: win.height });
    });
  }

  // ─── Mobile Tab Bar ───
  var tabBar = null;
  var tabBarTimeout = null;

  function renderTabBar() {
    if (!isMobile()) {
      if (tabBar) { tabBar.remove(); tabBar = null; }
      return;
    }
    if (store.windows.length === 0) {
      if (tabBar) { tabBar.remove(); tabBar = null; }
      return;
    }

    if (!tabBar) {
      tabBar = document.createElement("div");
      tabBar.id = "crow-wm-tabbar";
      tabBar.style.cssText =
        "position:fixed;top:0;left:0;right:0;height:" + TAB_BAR_HEIGHT + "px;" +
        "z-index:9500;background:rgba(15,15,23,0.92);backdrop-filter:blur(8px);" +
        "border-bottom:1px solid rgba(61,61,77,0.5);display:flex;align-items:center;" +
        "padding:0 4px;gap:4px;overflow-x:auto;-webkit-overflow-scrolling:touch;" +
        "transition:opacity 0.3s;font-family:'DM Sans',sans-serif;";
      document.body.appendChild(tabBar);

      // Auto-hide after 3s
      scheduleTabBarHide();

      // Tap top edge to reveal
      tabBar.addEventListener("touchstart", function() { showTabBar(); });
    }

    // Rebuild pills
    while (tabBar.firstChild) tabBar.removeChild(tabBar.firstChild);

    // Avatar pill (always first)
    var avatarPill = createPill("\u2665", "Avatar", null, function() {
      store.closeAll();
    });
    avatarPill.style.borderColor = "rgba(99,102,241,0.6)";
    tabBar.appendChild(avatarPill);

    // Window pills
    for (var i = 0; i < store.windows.length; i++) {
      (function(win) {
        var icon = APP_ICONS[win.appId] || "\u25A1";
        var label = win.title.length > 12 ? win.title.substring(0, 11) + "\u2026" : win.title;
        var pill = createPill(icon, label, win.id, function() {
          store.focusWindow(win.id);
          renderAll();
        });
        if (win.id === store.focusedId) {
          pill.style.background = "rgba(99,102,241,0.25)";
          pill.style.borderColor = "#6366f1";
        }
        tabBar.appendChild(pill);
      })(store.windows[i]);
    }
  }

  function createPill(icon, label, winId, onClick) {
    var pill = document.createElement("button");
    pill.style.cssText =
      "flex-shrink:0;display:flex;align-items:center;gap:4px;" +
      "padding:6px 10px;min-height:32px;min-width:44px;" +
      "background:rgba(26,26,46,0.6);border:1px solid rgba(61,61,77,0.5);" +
      "border-radius:6px;color:#fafaf9;font-size:12px;font-family:inherit;" +
      "cursor:pointer;white-space:nowrap;";
    var iconSpan = document.createElement("span");
    iconSpan.textContent = icon;
    var labelSpan = document.createElement("span");
    labelSpan.textContent = label;
    pill.appendChild(iconSpan);
    pill.appendChild(labelSpan);
    pill.onclick = function() { showTabBar(); onClick(); };
    return pill;
  }

  function scheduleTabBarHide() {
    clearTimeout(tabBarTimeout);
    tabBarTimeout = setTimeout(function() {
      if (tabBar) tabBar.style.opacity = "0.15";
    }, 3000);
  }

  function showTabBar() {
    if (tabBar) tabBar.style.opacity = "1";
    scheduleTabBarHide();
  }

  // ─── Desktop Taskbar (true auto-hide) ───
  var TASKBAR_HEIGHT = 40;
  var TRIGGER_ZONE_HEIGHT = 6;
  var deskbar = null;
  var deskbarTrigger = null;
  var deskbarVisible = false;

  function renderDeskbar() {
    if (isMobile()) {
      removeDeskbar();
      return;
    }
    if (store.windows.length === 0) {
      removeDeskbar();
      return;
    }

    // Create trigger zone (invisible strip at bottom edge)
    if (!deskbarTrigger) {
      deskbarTrigger = document.createElement("div");
      deskbarTrigger.id = "crow-wm-deskbar-trigger";
      deskbarTrigger.style.cssText =
        "position:fixed;bottom:0;left:0;right:0;height:" + TRIGGER_ZONE_HEIGHT + "px;" +
        "z-index:9499;background:transparent;";
      deskbarTrigger.addEventListener("mouseenter", function() { showDeskbar(); });
      document.body.appendChild(deskbarTrigger);
    }

    // Create taskbar (starts hidden below the viewport)
    if (!deskbar) {
      deskbar = document.createElement("div");
      deskbar.id = "crow-wm-deskbar";
      deskbar.style.cssText =
        "position:fixed;bottom:0;left:0;right:0;height:" + TASKBAR_HEIGHT + "px;" +
        "z-index:9500;background:rgba(15,15,23,0.82);backdrop-filter:blur(14px);" +
        "border-top:1px solid rgba(61,61,77,0.35);display:flex;align-items:center;" +
        "justify-content:center;padding:0 12px;gap:6px;" +
        "transform:translateY(100%);transition:transform 0.2s ease;" +
        "font-family:'DM Sans',sans-serif;pointer-events:none;";
      deskbar.addEventListener("mouseenter", function() { showDeskbar(); });
      deskbar.addEventListener("mouseleave", function() { hideDeskbar(); });
      document.body.appendChild(deskbar);
    }

    // Rebuild pills
    while (deskbar.firstChild) deskbar.removeChild(deskbar.firstChild);

    for (var i = 0; i < store.windows.length; i++) {
      (function(win) {
        var pill = document.createElement("button");
        var icon = APP_ICONS[win.appId] || "\u25A1";
        var label = win.title.length > 20 ? win.title.substring(0, 19) + "\u2026" : win.title;
        var isActive = win.id === store.focusedId;
        pill.style.cssText =
          "display:flex;align-items:center;gap:5px;padding:4px 10px;height:28px;" +
          "border-radius:6px;font-size:12px;font-family:inherit;cursor:pointer;" +
          "white-space:nowrap;border:1px solid;transition:all 0.2s;" +
          (isActive
            ? "background:rgba(99,102,241,0.12);border-color:rgba(99,102,241,0.4);color:#fafaf9;"
            : "background:rgba(26,26,46,0.5);border-color:rgba(61,61,77,0.4);color:#a8a29e;");
        var iconSpan = document.createElement("span");
        iconSpan.textContent = icon;
        iconSpan.style.fontSize = "13px";
        pill.appendChild(iconSpan);
        var labelSpan = document.createElement("span");
        labelSpan.textContent = label;
        pill.appendChild(labelSpan);
        if (isActive) {
          var dot = document.createElement("span");
          dot.style.cssText = "width:4px;height:4px;border-radius:50%;background:#6366f1;";
          pill.appendChild(dot);
        }
        pill.onclick = function() { store.focusWindow(win.id); };
        pill.onmouseenter = function() {
          if (!isActive) { pill.style.background = "rgba(26,26,46,0.8)"; pill.style.color = "#fafaf9"; }
        };
        pill.onmouseleave = function() {
          if (!isActive) { pill.style.background = "rgba(26,26,46,0.5)"; pill.style.color = "#a8a29e"; }
        };
        deskbar.appendChild(pill);
      })(store.windows[i]);
    }

    // "+" launcher button
    var plusBtn = document.createElement("button");
    plusBtn.style.cssText =
      "width:28px;height:28px;border-radius:6px;border:1px dashed rgba(61,61,77,0.5);" +
      "background:transparent;color:#78716c;font-size:16px;display:flex;align-items:center;" +
      "justify-content:center;cursor:pointer;margin-left:4px;transition:all 0.2s;";
    plusBtn.textContent = "+";
    plusBtn.onclick = function() { showLauncher(); };
    plusBtn.onmouseenter = function() {
      plusBtn.style.borderColor = "#6366f1"; plusBtn.style.color = "#6366f1";
      plusBtn.style.borderStyle = "solid"; plusBtn.style.background = "rgba(99,102,241,0.12)";
    };
    plusBtn.onmouseleave = function() {
      plusBtn.style.borderColor = "rgba(61,61,77,0.5)"; plusBtn.style.color = "#78716c";
      plusBtn.style.borderStyle = "dashed"; plusBtn.style.background = "transparent";
    };
    deskbar.appendChild(plusBtn);
  }

  function showDeskbar() {
    if (!deskbar) return;
    deskbarVisible = true;
    deskbar.style.transform = "translateY(0)";
    deskbar.style.pointerEvents = "auto";
  }

  function hideDeskbar() {
    if (!deskbar) return;
    deskbarVisible = false;
    deskbar.style.transform = "translateY(100%)";
    deskbar.style.pointerEvents = "none";
  }

  function removeDeskbar() {
    if (deskbar) { deskbar.remove(); deskbar = null; deskbarVisible = false; }
    if (deskbarTrigger) { deskbarTrigger.remove(); deskbarTrigger = null; }
  }

  // ─── App Launcher Overlay ───
  var launcher = null;

  var LAUNCHER_APPS = [
    { id: "youtube",  icon: "\u25B6", name: "YouTube",  desc: "Search and play videos" },
    { id: "browser",  icon: "\u2609", name: "Browser",  desc: "Open any web page" },
    { id: "blog",     icon: "\u270E", name: "Blog",     desc: "Read and write posts" },
    { id: "jellyfin", icon: "\u266B", name: "Jellyfin", desc: "Movies and TV shows" },
    { id: "romm",     icon: "\u265F", name: "RoMM",     desc: "Retro game library" },
    { id: "plex",     icon: "\u25B6", name: "Plex",     desc: "Movies and TV shows" },
    { id: "nest",     icon: "\u2302", name: "Nest",     desc: "Dashboard panels" },
    { id: "videocall", icon: "\uD83D\uDCF9", name: "Video Call", desc: "Call a contact" },
  ];

  function showLauncher() {
    if (launcher) return; // Already open

    launcher = document.createElement("div");
    launcher.id = "crow-wm-launcher";
    launcher.style.cssText =
      "position:fixed;inset:0;z-index:9700;background:rgba(10,10,18,0.7);" +
      "backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;" +
      "animation:crow-wm-open 0.2s ease;font-family:'DM Sans',sans-serif;";
    launcher.onclick = function(e) { if (e.target === launcher) hideLauncher(); };

    var panel = document.createElement("div");
    panel.style.cssText =
      "width:min(580px,88vw);background:#1a1a2e;border:1px solid rgba(61,61,77,0.6);" +
      "border-radius:14px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,0.6);" +
      "animation:crow-wm-open 0.25s cubic-bezier(0.22,0.68,0,1.04);";

    // Header
    var header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;";
    var title = document.createElement("h3");
    title.textContent = "Open App";
    title.style.cssText = "font-size:16px;font-weight:600;color:#fafaf9;margin:0;";
    var hint = document.createElement("span");
    hint.textContent = "or ask Crow by voice";
    hint.style.cssText = "font-size:11px;color:#78716c;";
    header.appendChild(title);
    header.appendChild(hint);
    panel.appendChild(header);

    // Grid
    var grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(3,1fr);gap:10px;";

    for (var i = 0; i < LAUNCHER_APPS.length; i++) {
      (function(app) {
        var card = document.createElement("div");
        card.style.cssText =
          "padding:16px 14px;background:#0f0f17;border:1px solid rgba(61,61,77,0.35);" +
          "border-radius:10px;cursor:pointer;transition:all 0.2s;display:flex;" +
          "flex-direction:column;gap:8px;";
        card.onmouseenter = function() {
          card.style.borderColor = "rgba(99,102,241,0.4)";
          card.style.background = "rgba(20,20,38,1)";
          card.style.transform = "translateY(-1px)";
          card.style.boxShadow = "0 4px 16px rgba(0,0,0,0.3)";
        };
        card.onmouseleave = function() {
          card.style.borderColor = "rgba(61,61,77,0.35)";
          card.style.background = "#0f0f17";
          card.style.transform = "none";
          card.style.boxShadow = "none";
        };
        card.onclick = function() {
          hideLauncher();
          // Dispatch a synthetic open command through the WM handler
          window.CrowWM.handleToolResult({
            content: JSON.stringify({ action: "open_prompt", app: app.id })
          });
        };

        var iconEl = document.createElement("div");
        iconEl.textContent = app.icon;
        iconEl.style.cssText = "font-size:24px;line-height:1;";
        card.appendChild(iconEl);
        var nameEl = document.createElement("div");
        nameEl.textContent = app.name;
        nameEl.style.cssText = "font-size:13px;font-weight:600;color:#fafaf9;";
        card.appendChild(nameEl);
        var descEl = document.createElement("div");
        descEl.textContent = app.desc;
        descEl.style.cssText = "font-size:11px;color:#78716c;line-height:1.4;";
        card.appendChild(descEl);

        grid.appendChild(card);
      })(LAUNCHER_APPS[i]);
    }

    panel.appendChild(grid);
    launcher.appendChild(panel);
    document.body.appendChild(launcher);
  }

  function hideLauncher() {
    if (!launcher) return;
    launcher.remove();
    launcher = null;
  }

  // ─── Render All ───
  function renderAll() {
    for (var i = 0; i < store.windows.length; i++) {
      renderWindow(store.windows[i]);
    }
    renderTabBar();
    renderDeskbar();
  }

  store.onChange(renderAll);

  // ─── WM Container ───
  var wmContainer = document.createElement("div");
  wmContainer.id = "crow-wm-container";
  wmContainer.style.cssText = "position:fixed;inset:0;z-index:298;pointer-events:none;";
  // Windows inside are pointer-events:auto via their own styles
  document.body.appendChild(wmContainer);

  // Voice panel offset: shift WM content when panel is visible (desktop only)
  // Voice panel is now a floating bottom-left stack — no WM offset needed.

  // Window styles + animations
  var wmStyle = document.createElement("style");
  wmStyle.textContent =
    ".crow-wm-window { pointer-events: auto; }" +
    "@keyframes crow-wm-open { from { opacity:0; transform:scale(0.92); } to { opacity:1; transform:scale(1); } }" +
    "@keyframes crow-wm-close { from { opacity:1; transform:scale(1); } to { opacity:0; transform:scale(0.92); } }" +
    ".crow-wm-window { animation: crow-wm-open 0.15s ease-out; }" +
    ".crow-wm-window.crow-wm-closing { animation: crow-wm-close 0.15s ease-in forwards; pointer-events:none; }";
  document.head.appendChild(wmStyle);

  // ─── Handle resize ───
  window.addEventListener("resize", function() {
    store.autoLayout();
    renderAll();
    updateAvatar();
  });

  // ─── YouTube IFrame API Commands ───
  // YouTube embeds accept postMessage commands in this format:
  // { "event": "command", "func": "playVideo", "args": [] }
  function sendYouTubeCommand(func, args) {
    var win = store.findByApp("youtube");
    if (!win) return;
    var el = document.getElementById(win.id);
    if (!el) return;
    var iframe = el.querySelector("iframe");
    if (!iframe || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage(JSON.stringify({
      event: "command", func: func, args: args || []
    }), "*");
  }

  function handleMediaCommand(data) {
    var app = data.app || "youtube";
    if (app !== "youtube") return; // Only YouTube supported for now

    switch (data.command) {
      case "play":
      case "resume": sendYouTubeCommand("playVideo"); break;
      case "pause": sendYouTubeCommand("pauseVideo"); break;
      case "mute": sendYouTubeCommand("mute"); break;
      case "unmute": sendYouTubeCommand("unMute"); break;
      case "volume_up": sendYouTubeCommand("setVolume", [80]); break;
      case "volume_down": sendYouTubeCommand("setVolume", [30]); break;
    }
  }

  // ─── Workspace Save/Load (localStorage) ───
  var WS_KEY = "crow-wm-workspaces";

  function saveWorkspace(name) {
    var layouts = JSON.parse(localStorage.getItem(WS_KEY) || "{}");
    layouts[name] = store.windows.map(function(w) {
      return { appId: w.appId, url: w.url, title: w.title, x: w.x, y: w.y, width: w.width, height: w.height };
    });
    localStorage.setItem(WS_KEY, JSON.stringify(layouts));
    return layouts[name].length;
  }

  function loadWorkspace(name) {
    var layouts = JSON.parse(localStorage.getItem(WS_KEY) || "{}");
    var layout = layouts[name];
    if (!layout || layout.length === 0) return false;
    store.closeAll();
    for (var i = 0; i < layout.length; i++) {
      var entry = layout[i];
      var id = store.addWindow({ appId: entry.appId, url: entry.url, title: entry.title });
      if (id) {
        var win = store.findById(id);
        if (win) {
          win.x = entry.x; win.y = entry.y;
          win.width = entry.width; win.height = entry.height;
        }
      }
    }
    store._notify();
    return true;
  }

  function listWorkspaces() {
    var layouts = JSON.parse(localStorage.getItem(WS_KEY) || "{}");
    return Object.keys(layouts);
  }

  // ─── WS Message Handler ───
  window.CrowWM = {
    store: store,
    handleToolResult: function(msg) {
      if (!msg.content) return;
      var data;
      try { data = JSON.parse(msg.content); } catch(e) { return; }

      switch (data.action) {
        case "open":
          store.addWindow({
            appId: data.app || "browser",
            url: data.url || "",
            title: data.title || data.app || "Window",
            richContent: data.richContent || null,
          });
          break;
        case "close":
          store.closeByApp(data.app);
          break;
        case "close_focused":
          store.closeFocused();
          break;
        case "close_all":
          store.closeAll();
          break;
        case "media":
          handleMediaCommand(data);
          break;
        case "pet_launched":
          // Pet AppImage was spawned by the MCP server. Surface a toast so
          // the user knows something happened — the pet itself appears as
          // a separate native window outside the iframe sandbox.
          if (window.CrowToast && typeof window.CrowToast.show === "function") {
            window.CrowToast.show("Pet launched" + (data.anchor ? " (" + data.anchor + ")" : ""));
          }
          break;
        case "pet_closed":
          if (window.CrowToast && typeof window.CrowToast.show === "function") {
            window.CrowToast.show("Pet closed");
          }
          break;
        case "save_workspace":
          var count = saveWorkspace(data.name || "default");
          break;
        case "load_workspace":
          loadWorkspace(data.name || "default");
          break;
        case "list_workspaces":
          break;
        case "show_launcher":
          showLauncher();
          break;
        case "open_prompt":
          // From launcher click — open apps that don't need a query directly,
          // for query-based apps open with a sensible default
          var appDefaults = {
            youtube: null,  // needs query, skip
            browser: null,  // needs URL, skip
            blog: { url: "", title: "Blog" },
            jellyfin: { url: "", title: "Jellyfin" },
            plex: { url: "", title: "Plex" },
            romm: { url: "", title: "RoMM" },
            nest: { url: "", title: "Crow's Nest" },
            videocall: { url: "", title: "Video Call" },
          };
          var def = appDefaults[data.app];
          if (def) {
            // Construct a server-side open command via the same WS handler
            // We can't call the MCP server from here, so open directly with known URLs
            var host = window.location.hostname;
            var urls = {
              blog: "https://" + host + ":8444/blog/",
              nest: "https://" + host + ":8444/dashboard/nest",
              romm: "https://" + host + ":3080/",
              jellyfin: "",  // needs JELLYFIN_URL config
              plex: "",      // needs PLEX_URL config
              videocall: "https://" + host + ":8444/dashboard/calls",
            };
            if (urls[data.app]) {
              store.addWindow({ appId: data.app, url: urls[data.app], title: def.title });
            }
          }
          break;
        case "error":
          break;
      }
    },
  };

  // ─── State Snapshot (Phase 2A: late joiner sync) ───
  window.CrowWM.getStateSnapshot = function() {
    return store.windows.map(function(w) {
      return {
        appId: w.appId,
        url: w.url,
        title: w.title,
        richContent: w.richContent || null,
      };
    });
  };

  window.CrowWM.loadStateSnapshot = function(snapshot) {
    if (!snapshot || !snapshot.length) return;
    if (store.windows.length > 0) return;
    for (var i = 0; i < snapshot.length; i++) {
      var s = snapshot[i];
      store.addWindow({
        appId: s.appId || "browser",
        url: s.url || "",
        title: s.title || s.appId || "Window",
        richContent: s.richContent || null,
      });
    }
  };

  var _lastGroupSize = 0;

  // Register with shared WS bridge
  window.CrowWS = window.CrowWS || { handlers: [] };
  window.CrowWS.handlers.push(function(d) {
    // Handle tool call results from crow_wm
    if (d.type === "tool_call_status" && d.tool_name && (d.tool_name === "crow_wm" || d.tool_name.indexOf("crow_wm_") === 0) && d.status === "completed") {
      window.CrowWM.handleToolResult(d);
    }

    // Group update: send snapshot to new joiner
    if (d.type === "group-update" && d.members) {
      var newSize = d.members.length;
      if (newSize > _lastGroupSize && _lastGroupSize > 0 && store.windows.length > 0) {
        var snapshot = window.CrowWM.getStateSnapshot();
        if (snapshot.length > 0 && window.CrowWS._activeSocket) {
          try {
            window.CrowWS._activeSocket.send(JSON.stringify({
              type: "crow-wm-snapshot",
              snapshot: snapshot,
            }));
          } catch(e) {}
        }
      }
      _lastGroupSize = newSize;
    }

    // Receive snapshot from existing group member
    if (d.type === "crow-wm-snapshot" && d.snapshot) {
      window.CrowWM.loadStateSnapshot(d.snapshot);
    }

    // Shared WM control: apply remote actions
    if (d.type === "crow-wm-action" && d.action) {
      _remoteAction = true;
      try {
        var a = d.action;
        if (a.type === "close") {
          var w = findWindowByKey(a.appId, a.url);
          if (w) store.removeWindow(w.id);
        } else if (a.type === "close_all") {
          store.closeAll();
        } else if (a.type === "focus") {
          var w = findWindowByKey(a.appId, a.url);
          if (w) store.focusWindow(w.id);
        } else if (a.type === "move" && a.appId) {
          var w = findWindowByKey(a.appId, a.url);
          if (w) {
            w.x = a.x; w.y = a.y;
            if (a.width) w.width = a.width;
            if (a.height) w.height = a.height;
            var el = document.getElementById(w.id);
            if (el) {
              el.style.left = w.x + "px"; el.style.top = w.y + "px";
              el.style.width = w.width + "px"; el.style.height = w.height + "px";
            }
          }
        }
      } finally {
        _remoteAction = false;
      }
    }
  });

  // ─── Touch: tap top edge to reveal tab bar ───
  document.addEventListener("touchstart", function(e) {
    if (e.touches[0].clientY < 20 && tabBar) showTabBar();
  }, { passive: true });

  // ─── Keyboard Shortcuts ───
  document.addEventListener("keydown", function(e) {
    if (store.windows.length === 0) return;

    // Alt+Tab: cycle focus to next window
    if (e.altKey && e.key === "Tab") {
      e.preventDefault();
      var n = store.windows.length;
      if (n < 2) return;
      var idx = -1;
      for (var i = 0; i < n; i++) {
        if (store.windows[i].id === store.focusedId) { idx = i; break; }
      }
      var next = (idx + 1) % n;
      store.focusWindow(store.windows[next].id);
      return;
    }

    // Escape: dismiss launcher first, then close focused window
    if (e.key === "Escape") {
      e.preventDefault();
      if (launcher) { hideLauncher(); return; }
      store.closeFocused();
    }
  });

})();
