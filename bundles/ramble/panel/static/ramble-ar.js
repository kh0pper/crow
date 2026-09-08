/* Ramble AR — the overlay renderer (spec §6). Plain classic script, dual
 * Node/browser: window.RambleAr in a browser, module.exports under a
 * CommonJS loader, and it runs unchanged inside vm.runInNewContext (the
 * tests). NO ESM syntax, NO template literals (backticks), NO innerHTML:
 * every label is built with createElement + textContent, and the only markup
 * this file ever mounts is the bird; a caller-built art element is appended, never parsed.
 *
 * Contract: renderAr({ anchors, pose, bird, camera }) -> frame. It knows
 * nothing about maps, marks or nests. An anchor is
 *   { id, kind, lat, lon, accuracy_m, approx_m, locked, title, reach_m?, art? }
 * and the frame says where each label goes as FRACTIONS of the viewport, so
 * one frame paints any screen and the tests need no DOM. mountAr(els, opts)
 * is the DOM painter for that frame; a future WebXR painter consumes the
 * same state and adds surface placement.
 *
 * Camera frames never leave the device: this file never touches a canvas,
 * never captures, never uploads. The <video> is a background and nothing
 * more (the tests grep for the APIs that could change that).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module !== null && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.RambleAr = api;
})(this, function () {
  "use strict";

  var FOV_DEG = 70;            /* +-35 degrees is "in front of you" */
  var RANGE_M = 500;
  var COARSE_M = 150;          /* wider error radius than this: no direction is honest */
  var PARK_MAX = 6;            /* parked labels stacked per edge */
  var NEAR_Y = 0.70, FAR_Y = 0.34;
  var NEAR_SCALE = 1, FAR_SCALE = 0.5;
  var PARK_Y0 = 0.28, PARK_STEP = 0.07, PARK_SCALE = 0.7;
  var REACT_MS = 900;
  var NEAR_BOOST = 1.25;       /* a label within its anchor's reach_m is drawn larger */
  var TAP_MS = 350;            /* the press flash on any label */
  var FX_MS = 900;             /* a timed effect (collect) */
  var POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  var SVG_NS = "http://www.w3.org/2000/svg";

  function norm(deg) { var d = deg % 360; return d < 0 ? d + 360 : d; }
  function toRad(d) { return (d * Math.PI) / 180; }
  function toDeg(r) { return (r * 180) / Math.PI; }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function hasFix(pose) { return !!pose && isNum(pose.lat) && isNum(pose.lon); }
  function roundM(m) { return Math.max(5, Math.round(m / 5) * 5); }

  /* ------------------------------------------------------------- geometry */

  function distanceM(a, b) {
    var R = 6371000;
    var dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    var s = Math.pow(Math.sin(dLat / 2), 2) +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  /* Initial bearing from a to b, degrees clockwise from true north. */
  function bearingDeg(a, b) {
    var p1 = toRad(a.lat), p2 = toRad(b.lat), dl = toRad(b.lon - a.lon);
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return norm(toDeg(Math.atan2(y, x)));
  }

  /* bearing - heading folded into [-180, 180): negative = to your left. */
  function relativeBearing(bearing, heading) {
    return ((bearing - heading + 540) % 360) - 180;
  }

  function compassPoint(bearing) {
    return POINTS[Math.round(norm(bearing) / 45) % 8];
  }

  /* --------------------------------------------------------------- heading */

  /* A compass heading from a DeviceOrientation event, or null when the
   * event cannot give an absolute one. iOS: webkitCompassHeading already IS
   * the heading. Elsewhere alpha runs counter-clockwise from north, so the
   * heading is 360 - alpha, plus the screen's own rotation. */
  function headingFromEvent(ev, screenAngle) {
    if (!ev) return null;
    if (isNum(ev.webkitCompassHeading)) return norm(ev.webkitCompassHeading);
    if (!isNum(ev.alpha)) return null;
    if (ev.absolute !== true && ev.type !== "deviceorientationabsolute") return null;
    return norm(360 - ev.alpha + (isNum(screenAngle) ? screenAngle : 0));
  }

  /* Low-pass filter that crosses the 359 -> 1 wrap. */
  function smoothHeading(prev, next, k) {
    if (!isNum(next)) return isNum(prev) ? prev : null;
    if (!isNum(prev)) return norm(next);
    var gain = isNum(k) ? k : 0.25;
    return norm(prev + gain * relativeBearing(next, prev));
  }

  /* ---------------------------------------------------------------- layout */

  function subFor(d, locked) {
    return (locked ? "~" : "") + roundM(d) + " m" + (locked ? " · locked" : "");
  }

  function directionWord(rel) {
    if (Math.abs(rel) <= FOV_DEG / 2) return "ahead";
    if (rel <= -135 || rel >= 135) return "behind you";
    return rel < 0 ? "to your left" : "to your right";
  }

  /* One anchor against one pose: distance, bearing, and (with a heading) its
   * place on the screen, all as fractions 0..1 of the viewport. reach_m (an
   * optional per-anchor "close enough") makes it near; art says the caller
   * supplied an element the painter should show. */
  function layoutAnchor(anchor, pose) {
    var d = distanceM(pose, anchor);
    var b = bearingDeg(pose, anchor);
    var t = clamp01(d / RANGE_M);
    var near = isNum(anchor.reach_m) && d <= anchor.reach_m;
    var out = {
      id: anchor.id, kind: anchor.kind, title: anchor.title, locked: !!anchor.locked,
      distance_m: Math.round(d), bearing: Math.round(b), rel: null, visible: false, side: null,
      x: 0.5, y: NEAR_Y - (NEAR_Y - FAR_Y) * t, scale: NEAR_SCALE - (NEAR_SCALE - FAR_SCALE) * t,
      sub: near ? (anchor.locked ? "close enough · unlock" : (anchor.kind === "nest" ? "close enough · take it" : subFor(d, anchor.locked))) : subFor(d, anchor.locked),
      near: near,
      art: !!anchor.art,
    };
    if (near) out.scale = out.scale * NEAR_BOOST;
    if (isNum(pose.heading)) {
      var rel = relativeBearing(b, pose.heading);
      out.rel = Math.round(rel * 10) / 10;
      out.visible = Math.abs(rel) <= FOV_DEG / 2;
      if (out.visible) {
        out.x = 0.5 + rel / FOV_DEG;
      } else {
        out.side = rel < 0 ? "left" : "right";
        out.x = rel < 0 ? 0.06 : 0.94;
      }
    }
    return out;
  }

  function radarDot(item, headingUp) {
    var a = toRad(headingUp && isNum(item.rel) ? item.rel : item.bearing);
    var r = 0.25 + 0.75 * clamp01(item.distance_m / RANGE_M);
    return { id: item.id, kind: item.kind, locked: item.locked, x: 0.5 + 0.42 * r * Math.sin(a), y: 0.5 - 0.42 * r * Math.cos(a) };
  }

  function sayFor(mode, reason, items, visibleItems, coarseCount) {
    if (reason === "no-fix") return "Waiting for a fix…";
    if (items.length === 0 && coarseCount > 0) return "Something is around here, but I can't tell which way.";
    if (items.length === 0) return "Nothing within " + RANGE_M + " m. Walk a bit.";
    /* Reach beats sight: "right here" must not flip with the compass. Items are nearest-first. */
    for (var i = 0; i < items.length; i++) {
      if (items[i].near) return items[i].title + ", right here — " + roundM(items[i].distance_m) + " m.";
    }
    if (visibleItems.length > 0) return visibleItems[0].title + ", " + roundM(visibleItems[0].distance_m) + " m ahead.";
    var n = items[0];
    if (mode === "radar" || !isNum(n.rel)) return n.title + ", " + roundM(n.distance_m) + " m " + compassPoint(n.bearing) + ". Follow the ring.";
    return n.title + ", " + roundM(n.distance_m) + " m " + directionWord(n.rel) + ".";
  }

  /* The contract. camera defaults to true; pass false once getUserMedia failed. */
  function renderAr(state) {
    var s = state || {};
    var anchors = Array.isArray(s.anchors) ? s.anchors : [];
    var pose = s.pose || {};
    var camera = s.camera !== false;
    var fix = hasFix(pose);
    var heading = isNum(pose.heading);
    var mode = fix && camera && heading ? "ar" : "radar";
    var reason = !fix ? "no-fix" : (!camera ? "no-camera" : (!heading ? "no-heading" : null));

    var items = [], coarse = [];
    if (fix) {
      for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        if (!a || !isNum(a.lat) || !isNum(a.lon)) continue;
        if (isNum(a.approx_m) && a.approx_m > COARSE_M) {
          coarse.push({ id: a.id, kind: a.kind, title: a.title, sub: "somewhere in this area" });
          continue;
        }
        var item = layoutAnchor(a, pose);
        if (item.distance_m > RANGE_M) continue;
        items.push(item);
      }
    }
    items.sort(function (p, q) { return p.distance_m - q.distance_m; });

    var visible = [], labels = [], parkedLeft = 0, parkedRight = 0;
    if (mode === "ar") {
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        if (it.visible) { visible.push(it); labels.push(it); continue; }
        var rank = it.side === "left" ? parkedLeft++ : parkedRight++;
        if (rank < PARK_MAX) {
          it.y = PARK_Y0 + PARK_STEP * rank;
          it.scale = PARK_SCALE;
          labels.push(it);
        }
      }
      /* Far first, so the nearest label paints last and on top. */
      labels.sort(function (p, q) { return q.distance_m - p.distance_m; });
    }

    return {
      mode: mode,
      reason: reason,
      labels: labels,
      parked: { left: Math.max(0, parkedLeft - PARK_MAX), right: Math.max(0, parkedRight - PARK_MAX) },
      coarse: coarse,
      radar: {
        dots: items.map(function (it) { return radarDot(it, mode === "ar" || isNum(pose.heading)); }),
        list: items.map(function (it) {
          return { id: it.id, kind: it.kind, title: it.title, distance_m: it.distance_m,
            sub: (it.locked ? "~" : "") + roundM(it.distance_m) + " m · " + compassPoint(it.bearing) + (it.locked ? " · locked" : "") };
        }),
      },
      visible: visible.map(function (it) { return it.id; }),
      say: sayFor(mode, reason, items, visible, coarse.length),
      bird: s.bird || null,
    };
  }

  /* --------------------------------------------------------------- painter */

  /* els: { root, labels, radar (an <svg> group), list, coarse, bird (<svg>),
   * egg (<svg>), say, more, mode }. Any of them may be missing. opts:
   * { engine: the RambleBird API, onTap(id) }. */
  function mountAr(els, opts) {
    var e = els || {};
    var o = opts || {};
    var engine = o.engine || (typeof window !== "undefined" ? window.RambleBird : null);
    var byId = {};
    var prevVisible = {};
    var birdKey = null;
    var reactTimer = null;
    /* Label <button>s persist across frames, keyed by anchor id (C3): a frame
     * arrives on every orientation event, and a button rebuilt under the
     * finger never receives its click. Positions are UPDATED in place. */
    var nodes = {};
    /* The radar list and the coarse rows repaint only when their text changes. */
    var listKey = null;
    /* Art elements mounted per anchor id (once), the radar rows by id (for fx),
     * and per-element flash timers. */
    var arts = {};
    var rowNodes = {};

    function clear(el) { if (el) el.textContent = ""; }
    function pct(v) { return (v * 100).toFixed(2) + "%"; }
    function remove(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }
    function badgeFor(item) {
      if (item.kind === "nest") return "N";
      if (item.kind === "caw") return "C";
      return item.locked ? "?" : "M";
    }

    /* Built once per anchor id; the click closes over the id, which never changes. */
    function labelEl(id) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rb-ar-label";
      btn.setAttribute("data-id", id);
      var strong = document.createElement("strong");
      var sub = document.createElement("span");
      btn.appendChild(strong);
      btn.appendChild(sub);
      btn.addEventListener("click", function () {
        flash(btn, "rb-ar-tapped", TAP_MS);
        if (typeof o.onTap === "function") o.onTap(id);
      });
      return btn;
    }

    /* Everything about a label that can change between frames. order is the
     * paint order (far first), applied as z-index since DOM order now persists. */
    function placeLabel(btn, item, order) {
      btn.setAttribute("data-kind", item.kind);
      if (item.locked) btn.setAttribute("data-locked", "true"); else btn.removeAttribute("data-locked");
      if (item.side) btn.setAttribute("data-side", item.side); else btn.removeAttribute("data-side");
      if (item.near) btn.setAttribute("data-near", "true"); else btn.removeAttribute("data-near");
      btn.style.left = pct(item.x);
      btn.style.top = pct(item.y);
      btn.style.transform = "translate(-50%, -50%) scale(" + item.scale.toFixed(3) + ")";
      btn.style.zIndex = String(10 + order);
      if (btn.children[0].textContent !== item.title) btn.children[0].textContent = item.title;
      if (btn.children[1].textContent !== item.sub) btn.children[1].textContent = item.sub;
    }

    /* Add a class for ms milliseconds, restarting the timer on a repeat. The timer lives
     * on the element so a label and a row with the same id never share one. */
    function flash(el, cls, ms) {
      el.classList.add(cls);
      var timers = el.rbFxTimers || (el.rbFxTimers = {});
      if (timers[cls]) clearTimeout(timers[cls]);
      timers[cls] = setTimeout(function () { el.classList.remove(cls); delete timers[cls]; }, ms);
    }

    /* The caller's art element goes in once, as the LAST child: placeLabel
     * addresses the title and sub by index (children[0]/[1]), and CSS order
     * puts the art first on screen. */
    function mountArt(btn, id) {
      var a = byId[id] && byId[id].art;
      if (!a || arts[id]) return;
      btn.appendChild(a);
      arts[id] = a;
    }

    function rowEl(item) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rb-step rb-ar-row";
      btn.setAttribute("data-id", item.id);
      /* the coarse strip reuses rowEl, so a coarse id would overwrite a row's entry — coarse anchors never have an fx today */
      rowNodes[item.id] = btn;
      var badge = document.createElement("span");
      badge.className = "rb-step-n";
      badge.textContent = badgeFor(item);
      var txt = document.createElement("div");
      txt.className = "rb-step-txt";
      var strong = document.createElement("strong");
      strong.textContent = item.title;
      var sub = document.createElement("span");
      sub.className = "rb-muted rb-fine";
      sub.textContent = item.sub;
      txt.appendChild(strong);
      txt.appendChild(sub);
      btn.appendChild(badge);
      btn.appendChild(txt);
      btn.addEventListener("click", function () { if (typeof o.onTap === "function") o.onTap(item.id); });
      return btn;
    }

    function paintRadar(frame) {
      if (e.radar) {
        /* Dots are not tappable, so rebuilding them each frame is fine. */
        clear(e.radar);
        frame.radar.dots.forEach(function (dot) {
          var c = document.createElementNS(SVG_NS, "circle");
          c.setAttribute("cx", (dot.x * 100).toFixed(2));
          c.setAttribute("cy", (dot.y * 100).toFixed(2));
          c.setAttribute("r", dot.kind === "nest" ? "3.2" : "2.6");
          c.setAttribute("class", "rb-ar-dot rb-ar-dot-" + dot.kind + (dot.locked ? " is-locked" : ""));
          e.radar.appendChild(c);
        });
      }
      /* Rows ARE tappable: repaint only when what they say changes (distances
       * move in 5 m steps, so this is a few times a minute on foot, not 60 Hz). */
      var coarseRows = frame.coarse.map(function (item) { return { id: item.id, kind: item.kind, title: item.title, sub: item.sub, locked: false }; });
      var key = frame.mode + "#" + frame.radar.list.map(function (i) { return i.id + "|" + i.title + "|" + i.sub; }).join(";") + "#" +
        coarseRows.map(function (i) { return i.id + "|" + i.title + "|" + i.sub; }).join(";");
      if (key === listKey) return;
      listKey = key;
      rowNodes = {};
      if (e.list) {
        clear(e.list);
        frame.radar.list.forEach(function (item) { e.list.appendChild(rowEl(item)); });
        /* In radar mode the list is the whole inventory, coarse rows included
         * (the separate coarse strip is hidden there — it would collide). */
        if (frame.mode === "radar") coarseRows.forEach(function (item) { e.list.appendChild(rowEl(item)); });
      }
      if (e.coarse) {
        clear(e.coarse);
        coarseRows.forEach(function (item) { e.coarse.appendChild(rowEl(item)); });
      }
    }

    function paintBird(bird) {
      var valid = !!(engine && bird && typeof engine.isValidBird === "function" && engine.isValidBird({ species: bird.species, seed: bird.seed }));
      if (e.bird) e.bird.hidden = !valid;
      if (e.egg) e.egg.hidden = valid;
      if (!valid) { birdKey = null; return; }
      var key = bird.species + ":" + bird.seed + ":" + (bird.mood || "happy");
      if (key === birdKey) return;
      birdKey = key;
      try { engine.mountBird(e.bird, engine.rollGenome(bird.seed, bird.species), bird.mood || "happy"); } catch (err) { /* cosmetic */ }
    }

    function react() {
      if (!e.bird || e.bird.hidden) return;
      e.bird.classList.add("rb-ar-react");
      if (reactTimer) clearTimeout(reactTimer);
      reactTimer = setTimeout(function () { e.bird.classList.remove("rb-ar-react"); reactTimer = null; }, REACT_MS);
    }

    function modeLabel(frame) {
      if (frame.mode === "ar") return "AR";
      if (frame.reason === "no-camera") return "Radar · no camera";
      if (frame.reason === "no-heading") return "Radar · no compass";
      return "Radar";
    }

    function render(state) {
      var frame = renderAr(state);
      byId = {};
      ((state && state.anchors) || []).forEach(function (a) { if (a && a.id != null) byId[a.id] = a; });
      if (e.root) {
        e.root.setAttribute("data-mode", frame.mode);
        e.root.setAttribute("data-reason", frame.reason || "");
        /* The video's visibility is the camera's state, not the mode's reason:
         * no fix + no camera reports "no-fix" and must still hide the black video. */
        e.root.setAttribute("data-camera", state && state.camera === false ? "off" : "on");
      }
      if (e.mode) e.mode.textContent = modeLabel(frame);
      if (e.labels) {
        var keep = {};
        frame.labels.forEach(function (item, order) {
          var btn = nodes[item.id];
          if (!btn) { btn = labelEl(item.id); nodes[item.id] = btn; e.labels.appendChild(btn); }
          mountArt(btn, item.id);
          placeLabel(btn, item, order);
          keep[item.id] = true;
        });
        Object.keys(nodes).forEach(function (id) {
          if (keep[id]) return;
          remove(nodes[id]);
          delete nodes[id];
          delete arts[id];
        });
      }
      if (e.more) {
        var more = [];
        if (frame.parked.left > 0) more.push("+" + frame.parked.left + " more to your left");
        if (frame.parked.right > 0) more.push("+" + frame.parked.right + " more to your right");
        e.more.textContent = more.join(" · ");
      }
      paintRadar(frame);
      paintBird(frame.bird);
      if (e.say) e.say.textContent = frame.say;
      var entered = false;
      var nowVisible = {};
      frame.visible.forEach(function (id) { nowVisible[id] = true; if (!prevVisible[id]) entered = true; });
      prevVisible = nowVisible;
      if (entered) react();
      return frame;
    }

    /* A named effect on everything showing this id: the AR label and the
     * radar-list row. busy is sticky (until clear); collect is timed and hops
     * the bird. Returns false when nothing shows the id. */
    function fx(id, name) {
      var targets = [];
      if (nodes[id]) targets.push(nodes[id]);
      if (rowNodes[id]) targets.push(rowNodes[id]);
      if (targets.length === 0) return false;
      targets.forEach(function (el) {
        if (name === "clear") { el.classList.remove("rb-ar-fx-busy"); return; }
        if (name === "busy") { el.classList.add("rb-ar-fx-busy"); return; }
        el.classList.remove("rb-ar-fx-busy");
        flash(el, "rb-ar-fx-" + name, FX_MS);
      });
      if (name === "collect") react();
      return true;
    }

    function destroy() {
      [nodes, rowNodes].forEach(function (m) { Object.keys(m).forEach(function (id) { var t = m[id].rbFxTimers || {}; Object.keys(t).forEach(function (k) { clearTimeout(t[k]); }); }); });
      if (reactTimer) { clearTimeout(reactTimer); reactTimer = null; }
      prevVisible = {};
      birdKey = null;
      byId = {};
      nodes = {};
      arts = {};
      rowNodes = {};
      listKey = null;
      [e.labels, e.radar, e.list, e.coarse].forEach(clear);
    }

    return { render: render, destroy: destroy, anchor: function (id) { return byId[id] || null; }, fx: fx };
  }

  /* ------------------------------------------------------------ first open */

  /* The limits notice gates the first open; the memory of it lives in web
   * storage, which can be absent or throwing (private mode, a blocked site).
   * getStorage is a function so even touching localStorage is inside the try. */
  function noticeSeen(getStorage, key) {
    try { return getStorage().getItem(key) === "1"; } catch (e) { return false; }
  }
  function markNoticeSeen(getStorage, key) {
    try { getStorage().setItem(key, "1"); return true; } catch (e) { return false; }
  }

  return {
    FOV_DEG: FOV_DEG, RANGE_M: RANGE_M, COARSE_M: COARSE_M, PARK_MAX: PARK_MAX, NEAR_BOOST: NEAR_BOOST, TAP_MS: TAP_MS, FX_MS: FX_MS,
    distanceM: distanceM, bearingDeg: bearingDeg, relativeBearing: relativeBearing, compassPoint: compassPoint,
    headingFromEvent: headingFromEvent, smoothHeading: smoothHeading,
    layoutAnchor: layoutAnchor, renderAr: renderAr, mountAr: mountAr,
    noticeSeen: noticeSeen, markNoticeSeen: markNoticeSeen,
  };
});
