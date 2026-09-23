/* Ramble panel client. Plain script (no modules, no bundler); served from
 * /ramble/static/ramble.js behind dashboardAuth.
 *
 * NO TEMPLATE LITERALS anywhere in this file -- panel scripts are handled by
 * tooling that treats backticks as its own delimiter; string concatenation is
 * the house style here. Remote content is written with textContent only, never
 * innerHTML: marks arrive from other people's personas. The one innerHTML path
 * is RambleBird.mountBird, which writes markup this page's own engine
 * generated from a (species, seed) pair -- never anybody's text.
 *
 * CSRF is handled for us -- the dashboard layout wraps window.fetch and adds
 * X-Crow-Csrf to every state-changing same-origin request.
 *
 * Sections, in order: net, views, map, marks, perch, compose, grid, egg, pet,
 * flock, contacts, trades, nests, hatch, ar, stream, startup.
 *
 * Phase 4: the AR view. This file owns the DEVICES (camera, GPS watch,
 * orientation) and the adapter from server rows to the renderer's anchors;
 * static/ramble-ar.js owns the maths and the painting. A tapped label opens
 * the same popup its map pin would (popupFor / nestPopup) inside #rb-ar-sheet,
 * so every AR action is a pin action. The camera stream is a background:
 * nothing reads its frames, nothing uploads.
 */
(function () {
  "use strict";

  var root = document.getElementById("ramble");
  if (!root) return;

  var Bird = window.RambleBird || null;

  var REDUCED = false;
  try {
    REDUCED = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (e) { REDUCED = false; }

  /* Kept in step with the .rb-hatch keyframes in ramble.css: 3 x 0.5s of
   * wobble then a 0.55s crack. Under reduced motion there is no animation to
   * wait for, so the reveal is immediate. */
  var HATCH_MS = REDUCED ? 0 : 2050;
  var RING_C = 678.6; /* 2 * PI * r, r = 108 in both ring SVGs */
  var MAX_NEARBY = 8;
  var MIN_NEST_ZOOM = 15;
  var CLAIM_M = 75;

  function $(id) { return document.getElementById(id); }
  function setText(el, text) { if (el) el.textContent = text; }
  /* "hidden" is an HTMLElement property; an <svg> does not have it, so
     assigning it directly on an element would set a dead expando while
     "#ramble [hidden]" keeps matching the attribute. Toggle the
     attribute itself instead. */
  function setHidden(el, on) {
    if (!el) return;
    if (on) el.setAttribute("hidden", ""); else el.removeAttribute("hidden");
  }

  /* ------------------------------------------------------------------ net */

  function jsonFetch(url, options) {
    var opts = options || {};
    opts.credentials = "same-origin";
    if (opts.body !== undefined && typeof opts.body !== "string") {
      opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(url, opts).then(function (res) {
      if (res.status === 204) return null;
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok) throw new Error((body && body.error) || ("request failed: " + res.status));
        return body;
      });
    });
  }

  /* ------------------------------------------------------------- contacts */

  var contactsCache = { contacts: [], groups: [] };

  function refreshContacts() {
    return jsonFetch("/api/ramble/contacts").then(function (out) {
      if (out && Array.isArray(out.contacts)) contactsCache = out;
      paintGroupChoice();
    }).catch(function () { /* no contacts, no pickers */ });
  }

  function nameFor(crowId) {
    var list = contactsCache.contacts || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].crow_id === crowId) return list[i].display_name || crowId;
    }
    return crowId || "someone";
  }

  /* ---------------------------------------------------------------- views */

  function showView(name) {
    /* Any navigation ends the hatch moment. hatchLock freezes the egg card so
     * the reveal is not repainted out from under the reader; leaving it set
     * when they walk away (Go outside, the perch, My bird) froze the egg view
     * for the rest of the session. */
    if (root.getAttribute("data-view") !== name) clearHatch();
    root.setAttribute("data-view", name);
    try { window.scrollTo(0, 0); } catch (e) { /* not fatal */ }
    /* Leaflet measures its container once; a container that was display:none
     * when the map was built comes back with a zero size until it is told. */
    if (name === "world" && map) { setTimeout(function () { map.invalidateSize(); }, 0); }
    if (name === "world") refreshNests();
    if (name === "egg") refreshEgg();
    if (name === "pet") refreshPet();
    if (name === "flock") { refreshContacts().then(refreshFlock); refreshTrades(); }
  }

  /* ------------------------------------------------------------------ map */

  var mapEl = $("rb-map");
  var map = null;
  var markerLayer = null;
  var nestLayer = null;
  var zoneLayer = null;
  /* 11, not 15. Fog is an AREA overlay: its whole point is seeing the shape
   * of where you have been, which needs zooming OUT — but the old floor of
   * 15 (copied from the nest-pin floor) meant the viewport was always
   * SMALLER than a player's revealed region, so they stood inside their own
   * cleared ground and never saw its edge. /zones no longer has a size
   * ceiling, so this can go low. */
  var MIN_ZONE_ZOOM = 11;
  /* Per-cell detail: the dim frontier squares and the seed pips. There can be
   * thousands of each, and both only mean anything up close, so below this the
   * mask holes alone carry the shape and the server is told not to even build
   * the pip list. */
  var MIN_CELL_DETAIL_ZOOM = 15;
  var hereLayer = null, hereDot = null, hereRing = null;
  /* The opening frame is a WALK, not a survey. At 15 the map showed about
   * 1.5 km across a phone, which put most of the visible seed beyond any
   * reasonable walk and out along roads with no footpath; 16 is about 730 m,
   * which is the range Kevin marked as somewhere he would actually go. */
  var WALK_ZOOM = 16;
  var following = false, mapWatch = null, lastPanAt = null;
  var currentCells = [];
  var lastFix = null;      /* the most recent REAL geolocation fix */
  var lastPostedFix = null;
  var lastWalkFix = null;
  var walkStopTimer = null;
  var momentTimer = null;
  var spokeMarks = null;
  var spokeNests = null;
  var lastMarks = [];

  if (mapEl && typeof L !== "undefined") {
    L.Icon.Default.imagePath = "/ramble/static/leaflet/images/";

    /* Tiles come from our OWN origin: the dashboard CSP is
     * img-src 'self' data: blob:, so a third-party tile host would be blocked.
     * /ramble/tiles proxies whatever ramble_settings.tile_url points at, which
     * also keeps the viewer's browser from ever talking to the tile host. */
    map = L.map(mapEl).setView([20, 0], 3);
    L.tileLayer("/ramble/tiles/{z}/{x}/{y}.png", {
      attribution: mapEl.getAttribute("data-tile-attribution") || "",
      maxZoom: 19,
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    nestLayer = L.layerGroup().addTo(map);

    /* Its own pane, above Leaflet's marker pane (600) and below popups (700):
     * the dot is the user's reference and must never hide under a pin. It ties
     * the tooltip pane (650), which Ramble never uses (pins carry a title). */
    map.createPane("rb-here");
    map.getPane("rb-here").style.zIndex = 650;
    hereLayer = L.layerGroup().addTo(map);

    /* 350: between Leaflet's tile pane (200) and its overlay pane (400).
     * NOT 450 — markerLayer's locked-mark teasers are plain circleMarkers with
     * no pane, so they render in the overlay pane at 400 and a 450 mask would
     * bury them. Those include the user's OWN and their contacts' locked marks
     * in fogged ground, which D4 says must be unaffected in every zone. */
    map.createPane("rb-fog");
    map.getPane("rb-fog").style.zIndex = 350;
    zoneLayer = L.layerGroup().addTo(map);
    map.on("dragstart", function () { setFollowing(false); });

    /* The Android shell wraps the WebView in a SwipeRefreshLayout for
     * pull-to-refresh; a northward drag on the map (which never itself
     * scrolls) would otherwise be read as "pull to refresh the page".
     * Suspend it for the duration of any touch on the map so Leaflet's own
     * pan/zoom gestures win. window.Crow is only injected inside the Android
     * app, and this must never let a native-bridge hiccup break the map. */
    mapEl.addEventListener("touchstart", function () {
      try {
        if (window.Crow && typeof Crow.setPullToRefresh === "function") Crow.setPullToRefresh(false);
      } catch (e) { /* not fatal to the map */ }
    });
    mapEl.addEventListener("touchend", function () {
      try {
        if (window.Crow && typeof Crow.setPullToRefresh === "function") Crow.setPullToRefresh(true);
      } catch (e) { /* not fatal to the map */ }
    });
    mapEl.addEventListener("touchcancel", function () {
      try {
        if (window.Crow && typeof Crow.setPullToRefresh === "function") Crow.setPullToRefresh(true);
      } catch (e) { /* not fatal to the map */ }
    });

    var areaTimer = null;
    map.on("moveend", function () {
      if (areaTimer) clearTimeout(areaTimer);
      areaTimer = setTimeout(function () { publishArea(); refreshNests(); refreshZones(); }, 500);
    });
  }

  /* ------------------------------------------------------------ you are here */

  /* Leaflet's divIcon html option is a markup sink and this file is held to
   * exactly two, so we never pass a string. It also accepts an ELEMENT, which
   * Leaflet appends rather than assigning — no sink, and no getElement()
   * timing to worry about. Note: no backticks anywhere in this file. */
  function hereIcon(art) {
    var opts = { className: "rb-here-pet", iconSize: [46, 46], iconAnchor: [23, 23] };
    if (art) opts.html = art;   /* an Element, never a string */
    /* No art means the bird engine did not load. Without a fallback the marker
     * is an empty invisible div and the player loses their own position, which
     * the retired circleMarker never did. Paint the old plain dot instead. */
    else opts.className = "rb-here-pet rb-here-plain";
    return L.divIcon(opts);
  }

  /* Fill the marker with whatever the perch would have shown: the bird once
   * one has hatched, otherwise the egg. Built with createElementNS and handed
   * to the shared engine, which is where the markup actually happens. */
  function hereArt() {
    if (!Bird) return null;
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    try {
      if (perchTarget === "pet" && lastPet && lastPet.bird) {
        svg.setAttribute("class", "rb-here-bird");
        Bird.mountBird(svg, Bird.rollGenome(lastPet.bird.seed, lastPet.bird.species), (lastPet && lastPet.mood) || "happy");
      } else if (eggSeedId) {
        /* The WALKING egg — legs and all. You are not carrying it, you are it. */
        svg.setAttribute("class", "rb-here-egg");
        svg.setAttribute("viewBox", "0 0 120 168");
        drawWalkingEggSeed(svg, seedFromEggId(eggSeedId));
      } else {
        /* No bird and no egg — the window between a first load and the
         * prologue's Go button. seedFromEggId(null) is 0, so drawing here
         * would show a phantom egg that does not exist. Return null and let
         * hereIcon draw its documented plain dot (static/ramble.js:219-222). */
        return null;
      }
    } catch (e) { return null; }
    return svg;
  }

  /* Re-skin the marker in place when the egg hatches or the mood changes. */
  function paintHereArt() {
    if (!hereDot) return;
    /* Unconditional: hereIcon(null) is the documented plain-dot path, and
     * skipping setIcon here would leave a stale egg on the map forever. */
    hereDot.setIcon(hereIcon(hereArt()));
    /* The retired perch was a button with an aria-label that tracked its
     * state; a divIcon is a focusable div with neither. Restore both. */
    var el = hereDot.getElement();
    if (el) {
      /* NOT role="button" any more: tapping no longer navigates, it asks. The
       * tooltip Leaflet opens on focus carries the answer, and Leaflet sets
       * aria-describedby to point at it, so a screen reader hears the status
       * on focus without us inventing anything. */
      el.setAttribute("role", "img");
      el.setAttribute("aria-label", "You");
      el.onkeydown = null;
    }
  }

  /* The world view's GPS-independent door. The map marker is the pretty way in;
   * this is the one that still works indoors, with location denied, or if
   * Leaflet never loads. Retiring the old corner button without this left the
   * view with no exit at all. */
  function paintPerchGo() {
    var go = $("rb-perch-open");
    if (!go) return;
    go.textContent = "How you're doing";
  }

  /* Shared with the area-post trigger: one notion of "moving" for both. */
  function markWalking() {
    if (!hereDot) return;
    var el = hereDot.getElement();
    if (!el) return;
    el.classList.add("is-walking");
    if (walkStopTimer) clearTimeout(walkStopTimer);
    walkStopTimer = setTimeout(function () {
      var e = hereDot && hereDot.getElement();
      if (e) e.classList.remove("is-walking");
    }, 2200);
  }

  function paintHere(fix) {
    if (!map || !hereLayer || !fix || typeof fix.lat !== "number" || typeof fix.lon !== "number") return;
    var ll = [fix.lat, fix.lon];
    var r = Math.max(5, Math.min(200, Number(fix.accuracy_m) || 20));
    if (!hereDot) {
      hereRing = L.circle(ll, { pane: "rb-here", radius: r, className: "rb-here-ring", stroke: false, fillOpacity: 0.12, interactive: false }).addTo(hereLayer);
      hereDot = L.marker(ll, {
        /* NO title option. Leaflet copies it to the element as a native HTML title,
         * which the browser renders as its own tooltip — and the marker now
         * carries a real Leaflet tooltip on the same hover, so keeping it would
         * stack a grey "You" box under the bird's speech bubble. The accessible
         * name comes from the aria-label paintHereArt sets, which is
         * state-aware in a way a fixed title never was. */
        pane: "rb-here", icon: hereIcon(hereArt()), keyboard: true,
      }).addTo(hereLayer);
      /* No showView here any more. Tapping the bird asks it what is around
       * (Leaflet opens the tooltip on click and on focus); the labelled strip
       * button is the door, and it works with no fix and no pointer. */
      bindPerchVoice();
      paintHereArt();
    } else {
      hereRing.setLatLng(ll);
      hereRing.setRadius(r);
      hereDot.setLatLng(ll);
    }
    if (!following) return;
    /* Following means the map scrolls under you and you stay in the middle of
     * it. The first version only panned once you had drifted out of the middle
     * 40% of the view, which reads as the map lurching every few hundred metres
     * rather than travelling with you.
     *
     * 10 m is the same floor the waddle uses: it clears typical high-accuracy
     * GPS jitter (3-15 m), so standing still does not creep the map. Frequent
     * pans are cheap here — the moveend work is debounced 500 ms and coalesces,
     * and the area post has its own independent 75 m ratchet in the watch, so
     * a continuous walk still reports itself even while pans keep collapsing. */
    if (!lastPanAt || haversineMeters(lastPanAt, fix) > 10) {
      lastPanAt = { lat: fix.lat, lon: fix.lon };
      map.panTo(ll, { animate: true });
    }
  }

  function setFollowing(on) {
    following = !!on;
    var chip = $("rb-chip-around");
    if (!chip) return;
    chip.classList.toggle("is-on", following);
    chip.setAttribute("aria-pressed", following ? "true" : "false");
  }

  /* One watch for the whole page: the dot, every walk hint (lastFix) and, when
   * the AR view is open, its pose. */
  function startMapWatch() {
    if (mapWatch != null || !map || !navigator.geolocation) return;
    mapWatch = navigator.geolocation.watchPosition(function (pos) {
      /* Captured BEFORE lastFix is reassigned. 10 m clears typical
       * high-accuracy GPS jitter (3-15 m) so a stationary user does not
       * waddle on the spot; C1's post is a separate 75 m ratchet. */
      var moved = lastWalkFix ? haversineMeters(lastWalkFix, { lat: pos.coords.latitude, lon: pos.coords.longitude }) : Infinity;
      if (moved > 10) {
        lastWalkFix = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        markWalking();
      }
      lastFix = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy_m: pos.coords.accuracy };
      paintHere(lastFix);
      /* The map only posts on moveend, and one manual pan turns following off
       * forever, so without this a walk unlocks nothing. Distance-driven and
       * independent of the map: 75 m is the unlock radius, so this cannot skip
       * a cell the user actually crossed. */
      if (!lastPostedFix || haversineMeters(lastPostedFix, lastFix) > 75) {
        lastPostedFix = { lat: lastFix.lat, lon: lastFix.lon };
        publishArea();
      }
      if (arOpen) {
        arPose.lat = lastFix.lat; arPose.lon = lastFix.lon; arPose.accuracy_m = lastFix.accuracy_m;
        maybeRefreshAround();
        scheduleArRender();
      }
    }, function (err) {
      /* No fix: no dot; the map still works by hand. Permission pulled
       * mid-session (code 1) while the AR view is open: its old fix is a lie
       * now — back to "Waiting for a fix…" (the AR view's own watch used to do this). */
      if (err && err.code === 1 && arOpen) { arPose.lat = null; arPose.lon = null; arAnchors = []; scheduleArRender(); }
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }

  function stopMapWatch() {
    if (mapWatch == null || !navigator.geolocation) { mapWatch = null; return; }
    try { navigator.geolocation.clearWatch(mapWatch); } catch (e) { /* gone */ }
    mapWatch = null;
  }
  /* The watch runs only while the page is shown: a hidden tab or a bfcache
   * park stops it (battery), coming back restarts it — startMapWatch is idempotent. */
  window.addEventListener("pagehide", stopMapWatch);
  window.addEventListener("pageshow", function () { startMapWatch(); });
  document.addEventListener("visibilitychange", function () { if (document.hidden) stopMapWatch(); else startMapWatch(); });

  function here() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) { reject(new Error("this browser has no geolocation")); return; }
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          lastFix = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy_m: pos.coords.accuracy,
          };
          resolve(lastFix);
        },
        function (err) { reject(new Error(err.message || "location unavailable")); },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
      );
    });
  }

  /* The active area is the subscriber's only input: post it when the view
   * settles, then redraw from whatever cells the server says that is. "here"
   * is the REAL fix and the only thing the server will credit a visit for --
   * panning the map must never farm warmth, so it is sent only when we have
   * an actual position. */
  function publishArea() {
    if (!map) return Promise.resolve();
    var c = map.getCenter();
    var body = { lat: c.lat, lon: c.lng };
    if (lastFix) body.here = { lat: lastFix.lat, lon: lastFix.lon, accuracy_m: lastFix.accuracy_m };
    return jsonFetch("/api/ramble/area", { method: "POST", body: body })
      .then(function (out) {
        currentCells = (out && out.cells) || [];
        /* Only when the server actually reported it: the seed key rides ONLY
         * on a post that carried a fix, so treating its absence as zero would
         * blank a real balance on every fix-less post and at boot without geo. */
        if (out && typeof out.seed === "number") paintSeed(out.seed);
        if (out && out.unlocked) celebrateUnlock(out.unlocked);
        /* A pickup is its own moment, and the pip it just consumed has to go —
         * an unlock repaints via celebrateUnlock, but a plain harvest does not. */
        if (out && out.seed_picked) celebrateSeed(out.seed_picked);
        if (out && typeof out.hearts === "number") paintHearts(out.hearts);
        if (out && out.heart_picked) {
          celebrateHeart(!!out.unlocked, out.heart_source, out.energy_max === out.energy_max_cap);
        }
        /* One /zones fetch however many pips were just consumed. celebrateUnlock
         * already refreshed on a first unlock, which is what the guard is for. */
        if (out && (out.seed_picked || out.heart_picked) && !out.unlocked) refreshZones();
        refreshPet();
        return refreshMarks();
      })
      .catch(function () { /* the map still works without a subscription */ });
  }

  /* A first unlock is a moment: flash the exact square just earned, then
   * repaint so the fog has actually retreated from it. The server tells us
   * this was the first time, so it fires once per cell ever, not on every
   * position post.
   *
   * NOT a box-shadow on the map container: an inset shadow paints beneath the
   * container's children, and Leaflet's tile pane is opaque and covers it, so
   * the flash would be invisible. A rectangle in the fog pane is on top of the
   * tiles and is the thing the user actually wants to see light up. */
  function celebrateUnlock(box) {
    sayMoment("New ground.");
    /* Its OWN layer, not zoneLayer: drawZones opens with clearLayers(), and
     * the refreshZones below resolves in tens of milliseconds, so a flash
     * parked in zoneLayer would be wiped long before its 900 ms animation
     * finished. */
    var bounds = cellBounds(box);
    if (bounds && hereLayer) {
      /* Pane and layer are independent: the rb-fog PANE (350) keeps the flash
       * under the pet marker instead of painting over it, while hereLayer is
       * the group drawZones never clears. */
      var flash = L.rectangle(bounds, {
        pane: "rb-fog", className: "rb-unlock-flash", stroke: false, interactive: false,
      }).addTo(hereLayer);
      setTimeout(function () { if (hereLayer) hereLayer.removeLayer(flash); }, 1200);
    }
    refreshZones();
    refreshMarks();
  }

  /* The pickup moment. Built with createElement + textContent, never a markup
   * sink. Absolutely positioned against the seed chip so it rises out of the
   * number it just changed. */
  function celebrateSeed(n) {
    var chip = $("rb-seed-count");
    var amount = Number(n);
    if (!chip || !chip.parentNode || !Number.isFinite(amount) || amount <= 0) return;
    var pop = document.createElement("span");
    pop.className = "rb-seed-pop";
    pop.textContent = "+" + amount;
    chip.parentNode.appendChild(pop);
    setTimeout(function () { if (pop.parentNode) pop.parentNode.removeChild(pop); }, 1100);
  }

  function paintSeed(n) {
    if (typeof n !== "number") return;
    var el = $("rb-seed-count");
    if (el) el.textContent = String(n);
  }

  /* The heart moment. A heart is rare enough to be worth saying out loud, so
   * this does both: the number pops, and the bird speaks. sayMoment is the only
   * thing that opens the bubble on its own, and an arrival is exactly what it
   * is for. */
  function celebrateHeart(alsoUnlocked, source, atCap) {
    var chip = $("rb-heart-count");
    if (chip && chip.parentNode) {
      var pop = document.createElement("span");
      pop.className = "rb-heart-pop";
      pop.textContent = "+1";
      chip.parentNode.appendChild(pop);
      setTimeout(function () { if (pop.parentNode) pop.parentNode.removeChild(pop); }, 1400);
    }
    /* ONE line, not two. celebrateUnlock has already said "New ground." on a
     * first unlock, and sayMoment holds for 4200ms -- a second call overwrites
     * the first, so the unlock moment would be erased every time a new cell
     * also paid a heart, which is one arrival in three. When both happen, say
     * the thing that covers both. */
    if (atCap) sayMoment("Another heart container. Your bird is as strong as it gets.");
    else if (alsoUnlocked) sayMoment("New ground, and a heart container in it.");
    else if (source === "wild") sayMoment("A heart container, grown here since you last came by.");
    else sayMoment("A heart container. Your bird can hold more now.");
  }

  function paintHearts(n) {
    if (typeof n !== "number") return;
    var el = $("rb-heart-count");
    if (el) el.textContent = String(n);
  }

  /* The containers themselves, above the bar they lengthened -- the number
   * alone never explained where the extra bar came from. Capped at a row that
   * still fits a phone; past that the sentence carries the count. */
  var HEART_ROW_MAX = 10;

  function paintHeartRow(n, max, cap) {
    var row = $("rb-heart-row");
    if (!row) return;
    while (row.firstChild) row.removeChild(row.firstChild);
    var shown = Math.max(0, Math.min(HEART_ROW_MAX, n));
    for (var i = 0; i < shown; i++) {
      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "rb-heart-one");
      var drew = false;
      if (Bird && typeof Bird.mountHeart === "function") {
        try { Bird.mountHeart(svg); drew = true; } catch (e) { /* cosmetic */ }
      }
      /* A failed mount must not leave an empty, invisible 16px gap in the row --
       * only append the element when the engine actually drew into it. */
      if (drew) row.appendChild(svg);
    }
    var line = $("rb-heart-line");
    if (!line) return;
    /* At the cap the bar cannot grow again, and saying nothing about that would
     * leave the player collecting pips that change no number they can see. */
    if (typeof cap === "number" && typeof max === "number" && n > 0 && max >= cap) {
      setText(line, n + " heart containers. The bar is as long as it goes.");
    } else if (n <= 0) setText(line, "No heart containers yet. Walk somewhere new.");
    else if (n === 1) setText(line, "One heart container.");
    else setText(line, n + " heart containers.");
  }

  /* ---------------------------------------------------------------- marks */

  /* The one label rule (spec 2026-09-08 §3.1), mirrored from server/labels.js:
   * yours, then a contact's saved name, then a stranger's world name with a
   * key tail (unverified, so the tail keeps two Kevins apart), then the key. */
  function markLabel(mark) {
    var noun = mark.kind === "caw" ? "caw" : "mark";
    if (mark.origin === "local" || mark.origin === "sync") return "your " + noun;
    if (mark.contact_name) return noun + " by " + mark.contact_name;
    var who = mark.author || "anon";
    if (mark.author_name) return noun + " by " + mark.author_name + " · " + who.slice(0, 4);
    return noun + " by " + who.slice(0, 8);
  }

  /** A stranger's bird on your map: the way to trade with them is to become contacts first. */
  function inviteLine(mark) {
    if (mark.origin !== "remote" || mark.contact_name) return null;
    var p = document.createElement("p");
    p.className = "rb-pop-body rb-fine";
    p.textContent = "Not a contact yet. ";
    var a = document.createElement("a");
    a.href = "/dashboard/contacts";
    a.textContent = "Share an invite";
    a.setAttribute("data-turbo", "true");
    p.appendChild(a);
    p.appendChild(document.createTextNode(" to gift or swap eggs."));
    return p;
  }

  function isLocked(mark) {
    return mark.reveal === "locked" && typeof mark.content_text !== "string";
  }

  function ago(ts) {
    if (typeof ts !== "number") return "just now";
    var mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + " h ago";
    return Math.round(hrs / 24) + " d ago";
  }

  /* The unlock radius the server actually enforces (anchors.js withinRange:
   * accuracy_m, defaulting to 75 m). We only ever know the CELL CENTRE, so a
   * distance from it is an estimate -- hence the "~" and the 5 m rounding. */
  var UNLOCK_M = 75;

  function haversineMeters(a, b) {
    var R = 6371000;
    var toRad = function (deg) { return (deg * Math.PI) / 180; };
    var dLat = toRad(b.lat - a.lat);
    var dLon = toRad(b.lon - a.lon);
    var s = Math.pow(Math.sin(dLat / 2), 2) +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  /**
   * How far the reader still has to walk. approx_m is NOT that number: it is
   * the geohash cell's own error radius, a constant ~101 m for every
   * precision-7 anchor, so printing it told every reader the same lie. A real
   * distance needs a real fix; without one we say so rather than invent one.
   */
  function walkHint(mark) {
    if (!lastFix || typeof mark.approx_lat !== "number" || typeof mark.approx_lon !== "number") {
      return "get closer to read it";
    }
    var m = haversineMeters(
      { lat: lastFix.lat, lon: lastFix.lon },
      { lat: mark.approx_lat, lon: mark.approx_lon }
    );
    if (m <= UNLOCK_M) return "you're close enough — unlock";
    return "walk ~" + (Math.round(m / 5) * 5) + " m to read it";
  }

  /** Non-public marks say who they are for; a public one needs no label. */
  function audienceHint(mark) {
    if (mark.visibility === "contacts") return "Contacts";
    if (typeof mark.visibility === "string" && mark.visibility.indexOf("group:") === 0) return "Group";
    if (mark.visibility === "private") return "Just me";
    return "";
  }

  /** A 40px portrait of the author's bird, drawn by the shared engine. */
  function birdFor(mark) {
    if (!Bird || !mark.bird_species || typeof mark.bird_seed !== "number") return null;
    if (!Bird.isValidBird({ species: mark.bird_species, seed: mark.bird_seed })) return null;
    try {
      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "rb-pop-bird");
      Bird.mountBird(svg, Bird.rollGenome(mark.bird_seed, mark.bird_species), "happy");
      return svg;
    } catch (e) { return null; }
  }

  /* A contact's profile picture on their pin (spec 2026-09-08 §5): the server
   * already bounded it to an inline data: image, and this checks again; a
   * stranger has none and keeps the bird. createElement + a src assignment —
   * not a markup sink. */
  function contactPortrait(mark) {
    var src = mark.contact_avatar;
    if (typeof src !== "string" || src.indexOf("data:image/") !== 0) return null;
    var img = document.createElement("img");
    img.className = "rb-pop-avatar";
    img.alt = "";
    img.src = src;
    return img;
  }

  function popupFor(mark) {
    var box = document.createElement("div");

    var head = document.createElement("div");
    head.className = "rb-pop-head";
    var portrait = contactPortrait(mark) || birdFor(mark);
    if (portrait) head.appendChild(portrait);
    var who = document.createElement("span");
    who.textContent = markLabel(mark);
    head.appendChild(who);
    var aud = audienceHint(mark);
    if (aud) {
      var tag = document.createElement("span");
      tag.className = "rb-aud";
      tag.textContent = aud;
      head.appendChild(tag);
    }
    box.appendChild(head);

    var body = document.createElement("p");
    body.className = "rb-pop-body";
    if (isLocked(mark)) {
      body.textContent = "Locked · " + walkHint(mark);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rb-pop-btn";
      btn.textContent = "Unlock here";
      btn.addEventListener("click", function () { unlock(mark, body, btn); });
      box.appendChild(body);
      box.appendChild(btn);
      var invLocked = inviteLine(mark); if (invLocked) box.appendChild(invLocked);
      return box;
    }
    body.textContent = mark.content_text || "(no text)";
    box.appendChild(body);
    var inv = inviteLine(mark); if (inv) box.appendChild(inv);
    return box;
  }

  function unlock(mark, bodyEl, btn) {
    btn.disabled = true;
    bodyEl.textContent = "checking where you are…";
    here().then(function (pos) {
      return jsonFetch("/api/ramble/unlock", {
        method: "POST",
        body: { mark_id: mark.mark_id, lat: pos.lat, lon: pos.lon },
      });
    }).then(function (result) {
      if (result && result.unlocked && result.content) {
        bodyEl.textContent = result.content.content_text || "(no text)";
        btn.remove();
      } else {
        bodyEl.textContent = "still too far away";
        btn.disabled = false;
      }
      handleHatched(result && result.hatched);
      refreshPet();
    }).catch(function (err) {
      bodyEl.textContent = err.message;
      btn.disabled = false;
    });
  }

  function drawMarks(marks) {
    /* drawNearby renders a list row per mark and statusLine counts
     * lastMarks: a beacon has no content_text, mark_id or created_at, so both
     * must work from the full marks only, never the raw response. */
    var full = marks.filter(function (m) { return !m.beacon; });
    lastMarks = full;
    if (markerLayer) markerLayer.clearLayers();
    marks.forEach(function (mark) {
      if (!markerLayer) return;
      if (mark.beacon) { drawBeacon(mark, markerLayer); return; }   /* forEach callback: return, never continue */
      if (typeof mark.lat === "number" && typeof mark.lon === "number") {
        /* An open mark publishes its real anchor: a normal pin. */
        var marker = L.marker([mark.lat, mark.lon], { title: markLabel(mark) });
        marker.bindPopup(popupFor(mark));
        marker.addTo(markerLayer);
      } else if (typeof mark.approx_lat === "number" && typeof mark.approx_lon === "number") {
        /* A locked teaser has no anchor -- only the coarse cell the server
         * decoded for us. Draw it as a dashed circle at the cell centre so it
         * reads as "somewhere in here", never as a precise point. A FIXED
         * pixel radius: approx_m is the same constant for every precision-7
         * cell, so scaling by it only ever produced one number. */
        var blob = L.circleMarker([mark.approx_lat, mark.approx_lon], {
          radius: 14,
          color: "#5b7cff",
          weight: 2,
          dashArray: "4 3",
          fillOpacity: 0.12,
        });
        blob.bindPopup(popupFor(mark));
        blob.addTo(markerLayer);
      }
    });
    drawNearby(full);
    noteMarks();
  }

  /* A frontier beacon: something is there, but not what. The server already
   * stripped every detail; this only says which kind it is. */
  function drawBeacon(mark, layer) {
    var cls = mark.kind === "nest" ? "rb-beacon rb-beacon-nest" : "rb-beacon";
    L.circleMarker([mark.lat, mark.lon], {
      className: cls, radius: 7, weight: 2, fillOpacity: 0.5, interactive: false,
    }).addTo(layer);
  }

  /** The list under the map mirrors the pins, newest first, capped. */
  function drawNearby(marks) {
    var list = $("rb-nearby");
    if (!list) return;
    list.textContent = "";
    /* The count is what is actually on screen (the list is capped), never the
     * whole result set -- a header that says 40 above 8 rows is a bug. */
    var shown = marks.slice(0, MAX_NEARBY);
    setText($("rb-nearby-count"), shown.length ? "Nearby · " + shown.length : "Nearby");

    if (marks.length === 0) {
      var empty = document.createElement("div");
      empty.className = "rb-step";
      var emptyTxt = document.createElement("div");
      emptyTxt.className = "rb-step-txt rb-muted";
      emptyTxt.textContent = "Nothing here yet. Be the first.";
      empty.appendChild(emptyTxt);
      list.appendChild(empty);
      return;
    }

    shown.forEach(function (mark) {
      var row = document.createElement("div");
      row.className = "rb-step";

      var badge = document.createElement("span");
      badge.className = "rb-step-n";
      badge.textContent = isLocked(mark) ? "?" : (mark.kind === "caw" ? "C" : "M");
      row.appendChild(badge);

      var txt = document.createElement("div");
      txt.className = "rb-step-txt";
      var title = document.createElement("strong");
      title.textContent = isLocked(mark) ? "A locked mark" : (mark.content_text || "(no text)");
      var sub = document.createElement("span");
      sub.className = "rb-muted rb-fine";
      sub.textContent = isLocked(mark)
        ? walkHint(mark)
        : (markLabel(mark) + " · " + ago(mark.created_at));
      txt.appendChild(title);
      txt.appendChild(sub);

      var aud = audienceHint(mark);
      if (aud) {
        var tag = document.createElement("span");
        tag.className = "rb-aud";
        tag.textContent = aud;
        txt.appendChild(tag);
      }

      row.appendChild(txt);
      list.appendChild(row);
    });
  }

  /* NO "visibility" filter. The route's no-filter branch is the owner's
   * overview: public + contacts + the user's OWN private rows, with the one
   * exclusion of a private row that arrived off the Nostr wire. Pinning it to
   * visibility=public hid Contacts and "Just me" marks from their own
   * author, on their own map. */
  function refreshMarks() {
    if (currentCells.length === 0) return Promise.resolve();
    return jsonFetch("/api/ramble/marks?cells=" +
      encodeURIComponent(currentCells.join(","))
    ).then(function (body) {
      drawMarks((body && body.marks) || []);
    }).catch(function () { /* a failed refresh keeps the last pins */ });
  }

  /* ---------------------------------------------------------------- perch */

  var perchTarget = "egg";
  var eggPercent = 0;
  var eggSeedId = null;
  var lastWaitingEggId = null;

  function setRing(circle, percent) {
    if (!circle) return;
    var pct = Math.max(0, Math.min(100, Number(percent) || 0));
    circle.setAttribute("stroke-dashoffset", String(RING_C * (1 - pct / 100)));
  }

  /** The egg id is a hex string; its first 8 chars are the drawing's seed. */
  function seedFromEggId(eggId) {
    var hex = String(eggId || "").replace(/[^0-9a-fA-F]/g, "").slice(0, 8);
    if (!hex) return 0;
    var n = parseInt(hex, 16);
    return Number.isFinite(n) ? (n >>> 0) : 0;
  }

  /* The ONE egg sink: engine output from a NUMBER. drawEggArt derives that
   * number from an egg id; nests carry theirs. */
  function drawEggSeed(el, seed) {
    if (!el || !Bird) return;
    try { el.innerHTML = Bird.drawEgg(seed >>> 0); } catch (e) { /* cosmetic */ }
  }
  function drawEggArt(el, eggId) { drawEggSeed(el, seedFromEggId(eggId)); }

  /* The WALKING egg, for the location marker only: legs and all, because you
   * are not carrying it, you are it. The write happens inside the engine's
   * own mountWalkingEgg, so this file's sink count does not move. */
  function drawWalkingEggSeed(el, seed) {
    if (!el || !Bird) return;
    try { Bird.mountWalkingEgg(el, seed >>> 0); } catch (e) { /* cosmetic */ }
  }

  function paintPerch(pet) {
    var bird = pet && pet.bird;
    var valid = !!(Bird && bird && Bird.isValidBird({ species: bird.species, seed: bird.seed }));
    perchTarget = valid ? "pet" : "egg";
    refreshPerchVoice();
    paintHereArt();
    paintPerchGo();
  }

  /* What the bird would say if asked. Ambient status, no longer shown
   * unprompted — the map was carrying this line permanently and it did not
   * earn the space. */
  function statusLine() {
    var line;
    if (perchTarget === "egg") {
      /* No egg at all: say nothing about warmth rather than claiming 0%. */
      line = eggSeedId ? "Your egg is " + Math.round(eggPercent) + "% warm." : "Quiet around here right now.";
    } else if (lastMarks.length === 0) {
      line = "Quiet around here right now.";
    } else {
      line = lastMarks.length === 1 ? "One thing waiting nearby." : (lastMarks.length + " things waiting nearby.");
    }
    /* lastNests is declared in the nests section further down; this function
     * only ever runs from fetch/stream callbacks, after the whole script has
     * been evaluated, so the var is initialised by then. The guard is belt. */
    if ((lastNests || []).length > 0) line += " There's a nest nearby.";
    return line;
  }

  /* The bird's voice is a Leaflet tooltip on the marker, not a box in the
   * strip. That buys three things the box could not: a real tail that points
   * at the bird, a position that tracks it, and — because Leaflet binds both
   * click and focus/blur for a non-permanent tooltip — tap-to-ask and
   * keyboard-to-ask for free. */
  function bindPerchVoice() {
    if (!hereDot || hereDot.getTooltip()) return;
    hereDot.bindTooltip("", { direction: "top", offset: [0, -16], className: "rb-voice", opacity: 1 });
    refreshPerchVoice();
  }

  /* Update the ambient line WITHOUT interrupting a moment that is on screen. */
  function refreshPerchVoice() {
    if (!hereDot || !hereDot.getTooltip() || momentTimer) return;
    hereDot.setTooltipContent(statusLine());
  }

  /* A moment: say it out loud, hold it, then fall back to ambient and go
   * quiet again. This is the only thing that opens the bubble on its own. */
  function sayMoment(text) {
    if (!text || !hereDot || !hereDot.getTooltip()) return;
    hereDot.setTooltipContent(text);
    hereDot.openTooltip();
    if (momentTimer) clearTimeout(momentTimer);
    momentTimer = setTimeout(function () {
      momentTimer = null;
      if (!hereDot || !hereDot.getTooltip()) return;
      hereDot.closeTooltip();
      refreshPerchVoice();
    }, 4200);
  }

  /* Only ARRIVALS speak — a count going down, or holding, is not news.
   *
   * ⚠ EACH SOURCE TRACKS ITS OWN FIRST LOOK. One shared flag looked simpler and
   * was wrong: marks and nests arrive from two independent fetches, and the egg
   * refresh (which needs no geolocation) normally resolves before either of
   * them. Whichever ran first consumed the single flag while lastMarks and
   * lastNests were still their empty initial values, so the real data landing
   * afterwards read as an arrival and the bird announced pre-existing marks on
   * every page load. Two sentinels, set only by their own source. */
  function noteMarks() {
    var n = lastMarks.length;
    if (spokeMarks !== null && n > spokeMarks) {
      sayMoment(n === 1 ? "One thing waiting nearby." : (n + " things waiting nearby."));
    } else {
      refreshPerchVoice();
    }
    spokeMarks = n;
  }

  function noteNests() {
    var n = (lastNests || []).length;
    /* Only the 0 -> something transition: a nest count merely changing is not
     * a nest ARRIVING within earshot. */
    if (spokeNests !== null && spokeNests === 0 && n > 0) {
      sayMoment("There's a nest nearby.");
    } else {
      refreshPerchVoice();
    }
    spokeNests = n;
  }

  /* -------------------------------------------------------------- compose */

  var reveal = "open";

  function wireSeg(segId, attr, onPick) {
    var seg = $(segId);
    if (!seg) return;
    var btns = Array.prototype.slice.call(seg.querySelectorAll("button"));
    btns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        btns.forEach(function (other) {
          other.classList.remove("is-on");
          other.setAttribute("aria-pressed", "false");
        });
        btn.classList.add("is-on");
        btn.setAttribute("aria-pressed", "true");
        onPick(btn.getAttribute(attr));
      });
    });
  }

  var whoChoice = "public";
  wireSeg("rb-seg-who", "data-visibility", function (v) {
    whoChoice = v || "public";
    var row = $("rb-group-row");
    if (row) setHidden(row, whoChoice !== "group");
  });
  wireSeg("rb-seg-reveal", "data-reveal", function (v) { reveal = v || "open"; });

  /** The visibility string the route wants: a group becomes "group:<uid>"; null = nothing chosen yet. */
  function composeVisibility() {
    if (whoChoice !== "group") return whoChoice;
    var sel = $("rb-group");
    return sel && sel.value ? "group:" + sel.value : null;
  }

  /** The Group segment only exists once there is a group to pick; losing the last group falls back to Everyone. */
  function paintGroupChoice() {
    var btn = $("rb-who-group");
    var sel = $("rb-group");
    var groups = contactsCache.groups || [];
    if (btn) setHidden(btn, groups.length === 0);
    if (groups.length === 0 && whoChoice === "group") {
      var everyone = document.querySelector('#rb-seg-who button[data-visibility="public"]');
      if (everyone) everyone.click();
    }
    if (!sel) return;
    var keep = sel.value;
    sel.textContent = "";
    groups.forEach(function (g) {
      var opt = document.createElement("option");
      opt.value = g.group_uid;
      opt.textContent = g.name + " (" + g.member_count + ")";
      sel.appendChild(opt);
    });
    if (keep) sel.value = keep;
  }

  function compose(kind) {
    var textEl = $("rb-text");
    var statusEl = $("rb-compose-status");
    var text = textEl ? textEl.value : "";
    if (!text.trim()) { setText(statusEl, "Write something first."); return; }
    var visibility = kind === "mark" ? composeVisibility() : "public";
    if (!visibility) { setText(statusEl, "Pick a group first."); return; }
    setText(statusEl, "Finding you…");
    here().then(function (pos) {
      var body = {
        kind: kind,
        lat: pos.lat,
        lon: pos.lon,
        accuracy_m: pos.accuracy_m,
        text: text,
      };
      if (kind === "mark") {
        body.visibility = visibility;
        body.reveal = reveal;
      }
      return jsonFetch("/api/ramble/marks", { method: "POST", body: body });
    }).then(function (out) {
      if (textEl) textEl.value = "";
      setText(statusEl, kind === "caw"
        ? "Cawed. It fades in an hour."
        : (visibility === "private"
          ? "Kept for you alone. Nobody else will ever see it."
          : (visibility === "public"
            ? "Left here. You're invisible until you flip Visible on."
            : ((out && out.recipients) ? "Sealed for " + out.recipients + (out.recipients === 1 ? " contact." : " contacts.") + " It goes out once Visible is on for contacts." : "Nobody to send it to yet. Add a contact first."))));
      handleHatched(out && out.hatched);
      refreshPet();
      refreshEgg();
      return refreshMarks();
    }).catch(function (err) { setText(statusEl, err.message); });
  }

  var leaveBtn = $("rb-leave");
  if (leaveBtn) leaveBtn.addEventListener("click", function () { compose("mark"); });
  var cawBtn = $("rb-caw");
  if (cawBtn) cawBtn.addEventListener("click", function () { compose("caw"); });

  var aroundChip = $("rb-chip-around");
  if (aroundChip) {
    aroundChip.addEventListener("click", function () {
      setFollowing(!following);
      if (!following) return;
      here().then(function (pos) {
        paintHere(pos);
        if (map) map.setView([pos.lat, pos.lon], Math.max(map.getZoom(), WALK_ZOOM));
      }).catch(function () { /* stay put */ });
    });
  }

  /* ----------------------------------------------------------------- grid */

  var sheetEl = $("rb-grid-sheet");
  var masterEl = $("rb-master");
  var identityEl = $("rb-identity");
  var worldNameEl = $("rb-world-name");
  var cellEls = Array.prototype.slice.call(document.querySelectorAll(".rb-grid-cell"));

  function openSheet(open) {
    if (!sheetEl) return;
    setHidden(sheetEl, !open);
    if (open && masterEl) masterEl.focus();
  }

  var visibleChip = $("rb-chip-visible");
  if (visibleChip) visibleChip.addEventListener("click", function () { openSheet(true); });
  var closeBtn = $("rb-grid-close");
  if (closeBtn) closeBtn.addEventListener("click", function () { openSheet(false); });
  if (sheetEl) {
    sheetEl.addEventListener("click", function (ev) { if (ev.target === sheetEl) openSheet(false); });
  }
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && sheetEl && !sheetEl.hidden) openSheet(false);
  });

  function paintGrid(grid) {
    if (!grid) return;
    if (masterEl) masterEl.checked = !!grid.master;
    if (identityEl && grid.identityLevel) identityEl.value = grid.identityLevel;
    if (worldNameEl && worldNameEl !== document.activeElement) worldNameEl.value = grid.worldName || "";
    if (worldNameEl) worldNameEl.placeholder = grid.identityLevel === "rotating" ? "not sent while Name is rotating" : "how strangers see you";
    cellEls.forEach(function (el) {
      var row = grid.cells && grid.cells[el.getAttribute("data-audience")];
      el.checked = !!(row && row[el.getAttribute("data-channel")]);
    });
    if (visibleChip) visibleChip.classList.toggle("is-on", !!grid.master);
    setText($("rb-chip-visible-label"), grid.master ? "Visible: on" : "Visible: off");
  }

  function postGrid(body) {
    setText($("rb-grid-status"), "Saving…");
    jsonFetch("/api/ramble/grid", { method: "POST", body: body })
      .then(function (grid) { paintGrid(grid); setText($("rb-grid-status"), "Saved."); })
      .catch(function (err) { setText($("rb-grid-status"), err.message); });
  }

  if (masterEl) masterEl.addEventListener("change", function () { postGrid({ master: masterEl.checked }); });
  if (identityEl) identityEl.addEventListener("change", function () { postGrid({ identityLevel: identityEl.value }); });
  if (worldNameEl) worldNameEl.addEventListener("change", function () { worldNameEl.blur(); postGrid({ worldName: worldNameEl.value }); });
  cellEls.forEach(function (el) {
    el.addEventListener("change", function () {
      var cells = {};
      cells[el.getAttribute("data-audience")] = {};
      cells[el.getAttribute("data-audience")][el.getAttribute("data-channel")] = el.checked;
      postGrid({ cells: cells });
    });
  });

  /* --------------------------------------------------------------- picker */

  var pickSheet = $("rb-pick-sheet");
  var pickOnChoose = null;

  function closePicker() {
    if (pickSheet) setHidden(pickSheet, true);
    pickOnChoose = null;
  }

  /** items: [{ label, sub, value }] -> onPick(value). Everything is text. */
  function openPicker(title, items, onPick) {
    var list = $("rb-pick-list");
    if (!pickSheet || !list) return;
    setText($("rb-pick-title"), title);
    list.textContent = "";
    if (items.length === 0) {
      var none = document.createElement("div");
      none.className = "rb-step";
      var t = document.createElement("div");
      t.className = "rb-step-txt rb-muted";
      t.textContent = "Nothing to pick from.";
      none.appendChild(t);
      list.appendChild(none);
    }
    items.forEach(function (item) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rb-step rb-pick";
      var txt = document.createElement("div");
      txt.className = "rb-step-txt";
      var strong = document.createElement("strong");
      strong.textContent = item.label;
      txt.appendChild(strong);
      if (item.sub) {
        var sub = document.createElement("span");
        sub.className = "rb-muted rb-fine";
        sub.textContent = item.sub;
        txt.appendChild(sub);
      }
      btn.appendChild(txt);
      btn.addEventListener("click", function () { var cb = pickOnChoose; closePicker(); if (cb) cb(item.value); });
      list.appendChild(btn);
    });
    pickOnChoose = onPick;
    setHidden(pickSheet, false);
  }

  var pickCancel = $("rb-pick-cancel");
  if (pickCancel) pickCancel.addEventListener("click", closePicker);
  if (pickSheet) pickSheet.addEventListener("click", function (ev) { if (ev.target === pickSheet) closePicker(); });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && pickSheet && !pickSheet.hidden) closePicker();
  });

  function contactItems() {
    return (contactsCache.contacts || []).map(function (c) {
      return { label: c.display_name || c.crow_id, sub: c.crow_id, value: c.crow_id };
    });
  }

  /* ------------------------------------------------------------------ egg */

  var hatchLock = false; /* the reveal owns the egg card until it is dismissed */

  function paintStep(stepId, done, label, line) {
    var step = $(stepId);
    if (!step) return;
    step.classList.toggle("is-done", !!done);
    setText($(stepId + "-n"), label);
    if (line != null) setText($(stepId + "-line"), line);
  }

  function paintEgg(state) {
    if (!state || hatchLock) return;
    var egg = state.egg;                      /* NULL when genuinely eggless */
    var list = state.checklist || {};

    var has = !!egg;
    eggPercent = has && typeof egg.percent === "number" ? egg.percent : 0;
    eggSeedId = has ? egg.egg_id : null;

    setRing($("rb-egg-ring"), eggPercent);
    setText($("rb-egg-percent"), has ? Math.round(eggPercent) + "%" : "—");
    setText($("rb-egg-line"), has
      ? "warmth " + (egg.warmth || 0) + " of " + (egg.hatch_at || 0) +
        " · it warms every time you get somewhere new"
      : "No one on the way just now.");
    setHidden($("rb-egg-empty"), has);

    var art = $("rb-egg-art");
    if (art) { setHidden(art, !has); if (has) drawEggArt(art, egg.egg_id); }
    var birdEl = $("rb-hatch-bird");
    if (birdEl) setHidden(birdEl, true);

    var places = list.new_places_week || 0;
    paintStep("rb-step-places", places >= 3, Math.min(places, 3) + "/3", null);
    paintStep("rb-step-mark", !!list.first_mark, list.first_mark ? "✓" : "·",
      list.first_mark ? "done — your first one is out there" : "nothing left yet");
    paintStep("rb-step-checkin", !!list.checked_in_today, list.checked_in_today ? "✓" : "·",
      list.checked_in_today ? "checked in today" : "a tap a day keeps it warm");

    refreshPerchVoice();
  }

  function refreshEgg() {
    return jsonFetch("/api/ramble/egg").then(paintEgg).catch(function () { /* the egg card is cosmetic */ });
  }

  var checkinBtn = $("rb-checkin");
  if (checkinBtn) {
    checkinBtn.addEventListener("click", function () {
      checkinBtn.disabled = true;
      setText($("rb-egg-status"), "Checking in…");
      jsonFetch("/api/ramble/egg/checkin", { method: "POST", body: {} })
        .then(function (out) {
          /* Three arms, not two. With no egg the credit was real but the
           * warmth had nowhere to land (D3), and a repeat tap is neither. */
          setText($("rb-egg-status"),
            !(out && out.credited) ? "Already checked in today — go somewhere instead."
            : out.egg ? "Checked in. That is today's warmth."
            : "Checked in. Nothing to warm yet — but it counted.");
          handleHatched(out && out.hatched);
          refreshPet();
          return refreshEgg();
        })
        .catch(function (err) { setText($("rb-egg-status"), err.message); })
        .then(function () { checkinBtn.disabled = false; });
    });
  }

  var outsideBtn = $("rb-go-outside");
  if (outsideBtn) outsideBtn.addEventListener("click", function () { showView("world"); });

  /* Remember whether the reference panel is folded. Ships open, because a new
   * player needs it; once you know the numbers it is just height above the
   * chores. Storage can throw outright (private mode, blocked site data), and a
   * remembered preference is never worth breaking the panel for. */
  var runsOn = $("rb-runs-on");
  if (runsOn) {
    try { if (window.localStorage.getItem("rb.runsOn") === "0") runsOn.open = false; } catch (e) { /* stays open */ }
    runsOn.addEventListener("toggle", function () {
      try { window.localStorage.setItem("rb.runsOn", runsOn.open ? "1" : "0"); } catch (e) { /* forget it, then */ }
    });
  }

  var perchOpenBtn = $("rb-perch-open");
  if (perchOpenBtn) perchOpenBtn.addEventListener("click", function () { showView(perchTarget); });

  /* ------------------------------------------------------------------ pet */

  var MOOD_LINE = {
    happy: "Perky. Whatever you have been doing, keep at it.",
    tired: "A bit droopy. A walk and a chore would sort it out.",
    alarmed: "Rattled and low. Three taps and some fresh air.",
  };

  var lastPet = null;

  /* Pure decision table for the Next-egg card's three states — an egg
   * incubating, nothing anywhere, one waiting on the shelf — extracted so it
   * is unit-testable without a DOM. A shelf egg waiting AND the empty line
   * both showing at once was a real regression here (two contradictory
   * lines on the one card that must never be hidden); paintPet is the only
   * caller, and does nothing but apply what this returns. */
  function nextEggVisibility(hasNext, waiting, hasLay) {
    var isWaiting = !!waiting;
    return {
      art: !hasNext,
      empty: hasNext || isWaiting,
      waiting: hasNext || !isWaiting,
      warm: hasNext || !isWaiting,
      lay: hasNext || !hasLay || isWaiting,
    };
  }

  function paintPet(pet) {
    if (!pet) return;
    lastPet = pet;
    paintPerch(pet);
    paintSeed(pet.seed);

    var bird = pet.bird;
    var valid = !!(Bird && bird && Bird.isValidBird({ species: bird.species, seed: bird.seed }));
    var petBird = $("rb-pet-bird");
    if (valid && petBird) {
      var genome = null;
      try { genome = Bird.rollGenome(bird.seed, bird.species); } catch (e) { genome = null; }
      if (genome) {
        try { Bird.mountBird(petBird, genome, pet.mood || "happy"); } catch (e) { /* cosmetic */ }
        var species = Bird.SPECIES[bird.species];
        setText($("rb-pet-name"), (species && species.name) || bird.species);
        setText($("rb-pet-traits"), [genome.eye, genome.mark, genome.hat].join(" · "));
      }
    } else {
      setText($("rb-pet-name"), "Still an egg");
      setText($("rb-pet-traits"), "nothing has hatched yet");
    }

    var energy = typeof pet.energy === "number" ? pet.energy : 0;
    /* Against the server's OWN ceiling. Drawing a percentage of a hardcoded 100
     * would paint a 150-energy bird at 150% and a 70-of-150 bird as nearly
     * full: the bar has to read the same number the server clamps with. */
    var max = typeof pet.energy_max === "number" && pet.energy_max > 0 ? pet.energy_max : 100;
    var fill = $("rb-energy-fill");
    if (fill) fill.style.width = Math.max(0, Math.min(100, (energy / max) * 100)) + "%";
    setText($("rb-energy-num"), String(energy));
    setText($("rb-energy-max"), String(max));
    var hearts = typeof pet.hearts === "number" ? pet.hearts : 0;
    paintHeartRow(hearts, max, pet.energy_max_cap);
    /* The map bar too, not only this page: the area response carries a wallet
     * ONLY when it carried a position fix, so a player who denies geolocation
     * would otherwise read 0 hearts on the map forever. paintSeed is called
     * from here for exactly this reason. */
    paintHearts(hearts);
    setText($("rb-mood-line"), MOOD_LINE[pet.mood] || MOOD_LINE.happy);

    var chores = pet.chores || {};
    Array.prototype.slice.call(document.querySelectorAll(".rb-chore")).forEach(function (btn) {
      var kind = btn.getAttribute("data-kind");
      var done = !!chores[kind];
      btn.classList.toggle("done", done);
      btn.setAttribute("aria-pressed", done ? "true" : "false");
    });

    setText($("rb-stat-places"), String(pet.places_week || 0));
    setText($("rb-stat-unlocks"), String(pet.unlocks_week || 0));
    setText($("rb-stat-crows"), String(pet.crows_week || 0));

    /* The next you, and the ONLY route back to the egg view (and its daily
     * check-in) once the perch belongs to a hatched bird. It changes state
     * when there is no egg; it is never hidden. */
    var nextEgg = pet.egg || null;
    var hasNext = !!nextEgg;
    var nextPct = hasNext && typeof nextEgg.percent === "number" ? nextEgg.percent : 0;
    if (hasNext) { eggPercent = nextPct; eggSeedId = nextEgg.egg_id; }
    else { eggPercent = 0; eggSeedId = null; }

    /* Nothing auto-promotes a shelf egg into an empty slot (see the server's
     * promoteFromShelf note), so offer it here rather than leaving the player
     * with no signal and no way back. It also means they are NOT eggless, so
     * the lay line must not claim they are — and NOR may the empty line,
     * which must not say "Nothing warming just now." while the waiting line
     * says one is. */
    var waiting = pet.shelf_waiting || null;
    var lay = pet.lay || null;
    var vis = nextEggVisibility(hasNext, waiting, !!lay);

    setRing($("rb-nextegg-ring"), nextPct);
    setText($("rb-nextegg-percent"), hasNext ? Math.round(nextPct) + "%" : "—");
    var nextArt = $("rb-nextegg-art");
    if (nextArt) { setHidden(nextArt, vis.art); if (hasNext) drawEggArt(nextArt, nextEgg.egg_id); }
    setHidden($("rb-nextegg-empty"), vis.empty);
    var waitingEl = $("rb-nextegg-waiting");
    setHidden(waitingEl, vis.waiting);
    /* A failed warm attempt overwrites this line with err.message (see the
     * rb-nextegg-warm click handler below); nothing else ever restores the
     * static copy, so it stays an error for the life of the page. Restore it
     * here, every time the card comes back to this state. */
    if (waitingEl && !vis.waiting) setText(waitingEl, "One's waiting on your shelf.");
    var warmEl = $("rb-nextegg-warm");
    setHidden(warmEl, vis.warm);
    /* incubate()'s own .catch only re-enables on FAILURE. A successful warm
     * leaves this disabled, and a later gift / claimed nest / lapsed swap
     * can repaint the card visible again with no incubate() call in
     * between — clear it here, every time the card comes back visible, so
     * the button is never shown dead. */
    if (warmEl && !vis.warm) warmEl.disabled = false;
    lastWaitingEggId = waiting;

    var layEl = $("rb-nextegg-lay");
    if (layEl) {
      setHidden(layEl, vis.lay);
      if (!vis.lay) {
        setText(layEl, lay.days > 0
          ? "You've had " + lay.days + " good " + (lay.days === 1 ? "day" : "days") +
            " — keep it up and you'll manage one yourself."
          : "Keep yourself happy and you'll manage one yourself, in time.");
      }
    }

    /* "My bird" only exists once there is one. */
    var myBird = $("rb-my-bird");
    if (myBird) setHidden(myBird, !valid);

    if (arOpen) scheduleArRender();
  }

  function refreshPet() {
    return jsonFetch("/api/ramble/pet").then(paintPet).catch(function () { /* pet is cosmetic */ });
  }

  Array.prototype.slice.call(document.querySelectorAll(".rb-chore")).forEach(function (btn) {
    btn.addEventListener("click", function () {
      btn.disabled = true;
      jsonFetch("/api/ramble/pet/chore", { method: "POST", body: { kind: btn.getAttribute("data-kind") } })
        .then(function (out) {
          setText($("rb-pet-status"), (out && out.done) ? "Done for today." : "Already done today.");
          return refreshPet();
        })
        .catch(function (err) { setText($("rb-pet-status"), err.message); })
        .then(function () { btn.disabled = false; });
    });
  });

  var backBtn = $("rb-back-world");
  if (backBtn) backBtn.addEventListener("click", function () { showView("world"); });

  var seeEggBtn = $("rb-see-egg");
  if (seeEggBtn) seeEggBtn.addEventListener("click", function () { showView("egg"); });
  var myBirdBtn = $("rb-my-bird");
  if (myBirdBtn) myBirdBtn.addEventListener("click", function () { showView("pet"); });

  var warmBtn = $("rb-nextegg-warm");
  if (warmBtn) warmBtn.addEventListener("click", function () {
    if (!lastWaitingEggId) return;
    incubate({ egg_id: lastWaitingEggId }, warmBtn)
      .catch(function (err) { setText($("rb-nextegg-waiting"), err.message); });
  });

  /* ---------------------------------------------------------------- nests */

  var lastNests = [];
  var nestMarkers = {};
  /* Until when the nest layer must NOT be rebuilt: a claimed pin is mid-pop
   * (900 ms) and the claim's own SSE echo arrives at once. */
  var nestPopUntil = 0;
  var nestWeek = null;

  /* Engine output from a numeric seed: the only markup sink besides drawEggArt. */
  function nestEggHtml(seed) {
    if (!Bird) return "<span></span>";
    try { return '<svg viewBox="0 0 120 152" aria-hidden="true">' + Bird.drawEgg(seed >>> 0) + "</svg>"; }
    catch (e) { return "<span></span>"; }
  }

  var nestArtCache = {};
  /* The egg the AR label shows when a nest is within reach: drawn by the one
   * egg sink from the nest's own seed, cached per cell so the painter keeps a
   * stable element; the claimed look is refreshed on every call. */
  function nestArt(nest) {
    var svg = nestArtCache[nest.cell];
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 120 152");
      svg.setAttribute("aria-hidden", "true");
      drawEggSeed(svg, nest.seed);
      nestArtCache[nest.cell] = svg;
    }
    svg.setAttribute("class", "rb-ar-egg-art" + (nest.claimed ? " is-claimed" : ""));
    return svg;
  }

  function nestWalkHint(nest) {
    if (!lastFix) return "get closer to take it";
    var m = haversineMeters({ lat: lastFix.lat, lon: lastFix.lon }, { lat: nest.lat, lon: nest.lon });
    if (m <= CLAIM_M) return "you're close enough — take it";
    return "walk ~" + (Math.round(m / 5) * 5) + " m to take it";
  }

  var CLAIM_REASON = {
    "too-far": "Get closer first.",
    "daily-limit": "One nest a day. Come back tomorrow.",
    "shelf-full": "Your shelf is full. Hatch something first.",
    "stale-week": "That nest is gone. The world re-rolls every week.",
    "no-nest": "Nothing here."
  };

  /* The collect effect on everything showing this nest: the AR label/row
   * (busy is sticky until clear; collect is timed) and the map pin. The pin's
   * animation targets its inner svg — the icon's own transform is its map
   * position. */
  /* Rebuild the nest layer now, or after a running pin pop ends. */
  function refreshNestsAfterPop() {
    var wait = nestPopUntil - Date.now();
    if (wait > 0) setTimeout(refreshNests, wait); else refreshNests();
  }

  function collectFx(cell, phase) {
    var name = phase === "done" ? "collect" : (phase === "start" ? "busy" : "clear");
    if (arOpen && arSession) arSession.fx("n:" + cell, name);
    var m = nestMarkers[cell];
    var el = m && typeof m.getElement === "function" ? m.getElement() : null;
    if (!el) return;
    el.classList.remove("rb-nest-busy");
    if (name === "busy") el.classList.add("rb-nest-busy");
    if (name === "collect") {
      nestPopUntil = Date.now() + 900;
      el.classList.add("rb-nest-collect");
      setTimeout(function () { el.classList.remove("rb-nest-collect"); }, 900);
    }
  }

  function claimNest(nest, lineEl, btn) {
    btn.disabled = true;
    btn.classList.add("is-busy");
    collectFx(nest.cell, "start");
    lineEl.textContent = "checking where you are…";
    here().then(function (pos) {
      return jsonFetch("/api/ramble/nests/claim", {
        method: "POST",
        body: { cell: nest.cell, week: nest.week, lat: pos.lat, lon: pos.lon }
      });
    }).then(function (out) {
      btn.classList.remove("is-busy");
      if (out && out.claimed) {
        lineEl.textContent = out.already ? "Already yours." : "You found an egg. It's on your shelf.";
        btn.remove();
        if (out.already) { collectFx(nest.cell, "clear"); refreshNests(); return refreshFlock(); }
        collectFx(nest.cell, "done");
        /* The fly-away plays on the AR label, not behind the sheet (the
         * "on your shelf" line is lost there — accepted: the bird's line and
         * the shelf say it); the layer is rebuilt only after the pin's pop
         * (refreshNestsAfterPop; the SSE echo waits too). */
        closeArSheet();
        refreshNestsAfterPop();
        return refreshFlock();
      }
      collectFx(nest.cell, "clear");
      lineEl.textContent = CLAIM_REASON[out && out.reason] || "Couldn't take it.";
      btn.disabled = false;
    }).catch(function (err) {
      btn.classList.remove("is-busy");
      collectFx(nest.cell, "clear");
      lineEl.textContent = err.message;
      btn.disabled = false;
    });
  }

  function nestPopup(nest) {
    var box = document.createElement("div");
    var head = document.createElement("div");
    head.className = "rb-pop-head";
    var who = document.createElement("span");
    who.textContent = "A nest";
    head.appendChild(who);
    box.appendChild(head);
    var line = document.createElement("p");
    line.className = "rb-pop-body";
    box.appendChild(line);
    if (nest.claimed) { line.textContent = "You already took this one."; return box; }
    line.textContent = nestWalkHint(nest);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rb-pop-btn";
    btn.textContent = "Take the egg";
    btn.addEventListener("click", function () { claimNest(nest, line, btn); });
    box.appendChild(btn);
    return box;
  }

  /* The map's three zones (spec 2026-09-08 section 2.1). The server owns every
   * geohash sum and sends footprints; the client punches them out of a mask. */
  function refreshZones() {
    if (!map || !zoneLayer) return Promise.resolve();
    /* The same two guards refreshNests carries. Without the zoom floor the
     * route 400s ("bbox too large") on every settle at low zoom, and the
     * .catch below would leave the last mask pinned over ground the user has
     * panned away from. */
    var root = $("ramble");
    if (root && root.getAttribute("data-view") !== "world") return Promise.resolve();
    /* A floor at all only so a world-zoom settle does not draw sub-pixel
     * geometry. The route itself no longer has a cell ceiling to trip. */
    if (map.getZoom() < MIN_ZONE_ZOOM) { zoneLayer.clearLayers(); return Promise.resolve(); }
    var b = map.getBounds();
    var bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].join(",");
    /* Only ask for pips when they will be drawn: zoomed out, that list is
     * thousands of footprints the client would discard. */
    var pips = map.getZoom() >= MIN_CELL_DETAIL_ZOOM ? "&pips=1" : "";
    return jsonFetch("/api/ramble/zones?bbox=" + encodeURIComponent(bbox) + pips)
      .then(drawZones)
      .catch(function () { /* a failed fetch leaves the last mask up */ });
  }

  /* One polygon: the padded viewport as the outer ring, every unlocked and
   * frontier cell as a hole. Leaflet fills even-odd, so the holes are clear
   * and everything else is fogged. Frontier cells get a dim square on top so
   * they read as previewed rather than owned. */
  /* Cloudy edges. Leaflet draws the mask as an SVG path, so a filter reference
   * on it works — but the filter itself has to exist somewhere in the document.
   * Built with createElementNS: no markup sink, no backticks. Injected once.
   *
   * The old mask had hard geohash-grid edges, which read as a spreadsheet
   * rather than as weather. Turbulence wobbles the boundary and the blur takes
   * the corners off. Keep the scale modest — displacement is per-pixel work on a
   * full-viewport path, and this runs on a phone. */
  function ensureFogFilter() {
    if (document.getElementById("rb-fog-clouds")) return;
    var NS = "http://www.w3.org/2000/svg";
    var host = document.createElementNS(NS, "svg");
    host.setAttribute("width", "0");
    host.setAttribute("height", "0");
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("class", "rb-defs");
    var filter = document.createElementNS(NS, "filter");
    filter.setAttribute("id", "rb-fog-clouds");
    filter.setAttribute("x", "-20%");
    filter.setAttribute("y", "-20%");
    filter.setAttribute("width", "140%");
    filter.setAttribute("height", "140%");
    var turb = document.createElementNS(NS, "feTurbulence");
    turb.setAttribute("type", "fractalNoise");
    turb.setAttribute("baseFrequency", "0.014");
    turb.setAttribute("numOctaves", "3");
    turb.setAttribute("seed", "11");
    turb.setAttribute("result", "rb-noise");
    var disp = document.createElementNS(NS, "feDisplacementMap");
    disp.setAttribute("in", "SourceGraphic");
    disp.setAttribute("in2", "rb-noise");
    disp.setAttribute("scale", "18");
    disp.setAttribute("xChannelSelector", "R");
    disp.setAttribute("yChannelSelector", "G");
    disp.setAttribute("result", "rb-wobbled");
    var blur = document.createElementNS(NS, "feGaussianBlur");
    blur.setAttribute("in", "rb-wobbled");
    blur.setAttribute("stdDeviation", "4");
    filter.appendChild(turb);
    filter.appendChild(disp);
    filter.appendChild(blur);
    host.appendChild(filter);
    document.body.appendChild(host);
  }

  function drawZones(out) {
    if (!out || !zoneLayer || !map) return;
    ensureFogFilter();
    zoneLayer.clearLayers();
    var b = map.getBounds().pad(0.5);
    var outer = [
      [b.getSouth(), b.getWest()], [b.getSouth(), b.getEast()],
      [b.getNorth(), b.getEast()], [b.getNorth(), b.getWest()]
    ];
    var fogHoles = [];
    addHoles(fogHoles, out.unlocked);
    addHoles(fogHoles, out.frontier);
    L.polygon([outer].concat(fogHoles), {
      pane: "rb-fog", className: "rb-fog", stroke: false, interactive: false
    }).addTo(zoneLayer);
    if (map.getZoom() >= MIN_CELL_DETAIL_ZOOM) {
      paintCells(out.frontier || [], "rb-frontier-cell");
      paintSeedPips(out.seed || []);
      paintHeartPips(out.hearts || []);
    }
  }

  /* A grain of seed in every unlocked cell whose seed has regrown: the map says
   * where walking pays, instead of the counter silently ticking up. Not
   * interactive — you collect by walking there, not by tapping.
   *
   * A real seed, not a dot: the first version used a plain circleMarker in the
   * UI accent, which read as map chrome rather than as something to go and get.
   * Each pip needs its OWN element — appending an Element MOVES it, so one
   * shared node would leave a single seed hopping between cells. */
  function seedIcon() {
    if (!Bird || typeof Bird.mountSeed !== "function") return null;
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    try { Bird.mountSeed(svg); } catch (e) { return null; }
    var opts = { className: "rb-seed-pip", iconSize: [18, 18], iconAnchor: [9, 9] };
    opts.html = svg;   /* an Element: Leaflet appends, so this is no markup sink */
    return L.divIcon(opts);
  }

  function paintSeedPips(spots) {
    for (var i = 0; i < spots.length; i++) {
      var c = spots[i];
      /* A POINT inside the cell, not the cell's box — the server places it so a
       * street's worth of seed does not line up like a pegboard. */
      if (!c || !isFinite(c.lat) || !isFinite(c.lon)) continue;
      var ll = [c.lat, c.lon];
      var icon = seedIcon();
      if (icon) {
        L.marker(ll, { pane: "rb-fog", icon: icon, interactive: false, keyboard: false }).addTo(zoneLayer);
      } else {
        /* The engine did not load. A dot is worse than a seed but far better
         * than nothing, since it still says "walking here pays". */
        L.circleMarker(ll, {
          pane: "rb-fog", className: "rb-seed-dot", radius: 4, weight: 0,
          fillOpacity: 0.9, interactive: false
        }).addTo(zoneLayer);
      }
    }
  }

  /* A heart container waiting in ground you have already unlocked: the rare
   * counterpart to a seed pip, and the reason an existing player has somewhere
   * to walk on the day this ships. Not interactive -- you collect it by walking
   * there, exactly like seed.
   *
   * Each pip needs its OWN element: appending an Element MOVES it, so one
   * shared node would leave a single heart hopping between cells. */
  function heartIcon() {
    if (!Bird || typeof Bird.mountHeart !== "function") return null;
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    try { Bird.mountHeart(svg); } catch (e) { return null; }
    var opts = { className: "rb-heart-pip", iconSize: [22, 22], iconAnchor: [11, 11] };
    opts.html = svg;   /* an Element: Leaflet appends, so this is no markup sink */
    return L.divIcon(opts);
  }

  function paintHeartPips(spots) {
    for (var i = 0; i < spots.length; i++) {
      var c = spots[i];
      if (!c || !isFinite(c.lat) || !isFinite(c.lon)) continue;
      var ll = [c.lat, c.lon];
      var icon = heartIcon();
      if (icon) {
        L.marker(ll, { pane: "rb-fog", icon: icon, interactive: false, keyboard: false }).addTo(zoneLayer);
      } else {
        L.circleMarker(ll, {
          pane: "rb-fog", className: "rb-heart-dot", radius: 5, weight: 0,
          fillOpacity: 0.95, interactive: false
        }).addTo(zoneLayer);
      }
    }
  }

  function addHoles(holes, cells) {
    for (var i = 0; i < (cells || []).length; i++) {
      var c = cells[i];
      if (!cellUsable(c)) continue;
      holes.push([[c.south, c.west], [c.south, c.east], [c.north, c.east], [c.north, c.west]]);
    }
  }

  /* One rectangle per cell. The footprint comes from the server's own list, so
   * the client never needs a geohash encoder. */
  function paintCells(cells, className) {
    for (var i = 0; i < cells.length; i++) {
      var box = cellBounds(cells[i]);
      if (!box) continue;
      L.rectangle(box, { pane: "rb-fog", className: className, stroke: false, interactive: false }).addTo(zoneLayer);
    }
  }

  function cellUsable(c) {
    return !!c && isFinite(c.south) && isFinite(c.west) && isFinite(c.north) && isFinite(c.east);
  }
  function cellBounds(c) {
    return cellUsable(c) ? [[c.south, c.west], [c.north, c.east]] : null;
  }

  function drawNests(list) {
    lastNests = list;
    if (!nestLayer) return;
    nestLayer.clearLayers();
    nestMarkers = {};
    list.forEach(function (nest) {
      if (nest.beacon) { drawBeacon(nest, nestLayer); return; }
      var icon = L.divIcon({
        className: "rb-nest-pin" + (nest.claimed ? " is-claimed" : ""),
        html: nestEggHtml(nest.seed),
        iconSize: [30, 38],
        iconAnchor: [15, 36],
        popupAnchor: [0, -30]
      });
      var marker = L.marker([nest.lat, nest.lon], { icon: icon, title: "A nest" });
      /* Built on open, not at draw time, so the walk hint uses the CURRENT fix
       * rather than the one we had when the pins were drawn. */
      marker.bindPopup(function () { return nestPopup(nest); });
      marker.addTo(nestLayer);
      nestMarkers[nest.cell] = marker;
    });
    noteNests();
  }

  /* Nests are computed server-side for the viewport; below MIN_NEST_ZOOM the
   * cover is too wide (the route 400s it) and pins would be noise anyway.
   * A hidden map (another view is showing) has no size and getBounds() is
   * meaningless, so skip until the world view is back and moveend fires. */
  function refreshNests() {
    if (!map || !nestLayer) return Promise.resolve();
    if (root.getAttribute("data-view") !== "world") return Promise.resolve();
    if (map.getZoom() < MIN_NEST_ZOOM) { drawNests([]); return Promise.resolve(); }
    var b = map.getBounds();
    var bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].join(",");
    return jsonFetch("/api/ramble/nests?bbox=" + encodeURIComponent(bbox))
      .then(function (out) { nestWeek = out && out.week; drawNests((out && out.nests) || []); })
      .catch(function () { drawNests([]); });
  }

  /* ---------------------------------------------------------------- flock */

  function birdTile(bird) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rb-flock-bird" + (bird.active ? " is-active" : "");
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 200 200");
    if (Bird && Bird.isValidBird({ species: bird.species, seed: bird.seed })) {
      try { Bird.mountBird(svg, Bird.rollGenome(bird.seed, bird.species), "happy"); } catch (e) { /* cosmetic */ }
    }
    btn.appendChild(svg);
    var name = document.createElement("span");
    var sp = Bird && Bird.SPECIES ? Bird.SPECIES[bird.species] : null;
    name.textContent = (sp && sp.name) || bird.species;
    btn.appendChild(name);
    if (bird.active) {
      var tag = document.createElement("span");
      tag.className = "rb-tag";
      tag.textContent = "With you";
      btn.appendChild(tag);
    }
    btn.setAttribute("aria-pressed", bird.active ? "true" : "false");
    btn.addEventListener("click", function () {
      if (bird.active) { showView("pet"); return; }
      btn.disabled = true;
      jsonFetch("/api/ramble/birds/" + encodeURIComponent(bird.egg_id) + "/activate", { method: "POST", body: {} })
        .then(function () { setText($("rb-flock-status"), "It's with you now."); refreshPet(); return refreshFlock(); })
        .catch(function (err) { setText($("rb-flock-status"), err.message); btn.disabled = false; });
    });
    return btn;
  }

  function eggSub(egg) {
    if (egg.status === "received") return "from " + nameFor(egg.from_crow_id);
    if (egg.found_cell) return "found in a nest, " + egg.found_week;
    if (egg.shelf_origin === "sync") return "came back from another of your Crows";
    return "your own egg";
  }

  function eggTitle(egg) {
    var what = egg.status === "incubating" ? "Incubating" : (egg.status === "received" ? "A gift" : "On the shelf");
    return what + " · " + Math.round(egg.percent || 0) + "%";
  }

  function shelfAction(egg, label, onClick) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rb-btn rb-btn-ghost rb-btn-sm";
    btn.textContent = label;
    btn.addEventListener("click", function () { onClick(btn); });
    return btn;
  }

  function flockStatus(msg) { setText($("rb-flock-status"), msg); }

  function incubate(egg, btn) {
    btn.disabled = true;
    return jsonFetch("/api/ramble/eggs/" + encodeURIComponent(egg.egg_id) + "/incubate", { method: "POST", body: {} })
      .then(function (out) {
        flockStatus("Swapped. The other one keeps its warmth on the shelf.");
        handleHatched(out && out.hatched);
        refreshEgg();
        refreshPet();
        return refreshFlock();
      })
      .catch(function (err) {
        flockStatus(err.message);
        btn.disabled = false;
        /* Rethrown so a caller off the flock view (the pet card's Warm it
         * button) can report the same failure somewhere ITS tap can see —
         * the flock view's own status line is elsewhere in the DOM. */
        throw err;
      });
  }

  function giftEgg(egg, btn) {
    openPicker("Give this egg to", contactItems(), function (crowId) {
      btn.disabled = true;
      jsonFetch("/api/ramble/eggs/" + encodeURIComponent(egg.egg_id) + "/gift", { method: "POST", body: { crow_id: crowId } })
        .then(function () { flockStatus("Sent to " + nameFor(crowId) + ". It leaves with the next relay tick."); return refreshFlock(); })
        .catch(function (err) { flockStatus(err.message); btn.disabled = false; });
    });
  }

  function proposeSwap(egg, btn) {
    openPicker("Offer this egg to", contactItems(), function (crowId) {
      btn.disabled = true;
      jsonFetch("/api/ramble/trades", { method: "POST", body: { egg_id: egg.egg_id, crow_id: crowId } })
        .then(function () { flockStatus("Offered to " + nameFor(crowId) + ". They pick what to give back."); refreshTrades(); return refreshFlock(); })
        .catch(function (err) { flockStatus(err.message); btn.disabled = false; });
    });
  }

  function eggRow(egg) {
    var row = document.createElement("div");
    row.className = "rb-step" + (egg.status === "incubating" ? " is-incubating" : "");
    var art = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    art.setAttribute("class", "rb-shelf-egg");
    art.setAttribute("viewBox", "0 0 120 152");
    drawEggArt(art, egg.egg_id);
    row.appendChild(art);
    var txt = document.createElement("div");
    txt.className = "rb-step-txt";
    var title = document.createElement("strong");
    title.textContent = eggTitle(egg);
    var sub = document.createElement("span");
    sub.className = "rb-muted rb-fine";
    sub.textContent = eggSub(egg);
    txt.appendChild(title);
    txt.appendChild(sub);
    row.appendChild(txt);
    if (egg.status === "incubating") return row;
    if (egg.locked) {
      var tag = document.createElement("span");
      tag.className = "rb-tag rb-tag-muted";
      tag.textContent = "In a swap";
      row.appendChild(tag);
      return row;
    }
    var acts = document.createElement("div");
    acts.className = "rb-acts";
    acts.appendChild(shelfAction(egg, "Incubate", function (b) { incubate(egg, b).catch(function () { /* already reported via flockStatus */ }); }));
    acts.appendChild(shelfAction(egg, "Gift", function (b) { giftEgg(egg, b); }));
    acts.appendChild(shelfAction(egg, "Swap", function (b) { proposeSwap(egg, b); }));
    row.appendChild(acts);
    return row;
  }

  function paintFlock(state) {
    if (!state) return;
    lastFlock = state;
    setText($("rb-flock-kinds"), state.species_total + " kinds, " + state.species_found + " found");
    var grid = $("rb-flock-birds");
    if (grid) {
      grid.textContent = "";
      (state.birds || []).forEach(function (b) { grid.appendChild(birdTile(b)); });
    }
    var empty = $("rb-flock-empty");
    if (empty) setHidden(empty, (state.birds || []).length > 0);
    var shelf = $("rb-shelf");
    if (shelf) {
      shelf.textContent = "";
      (state.eggs || []).forEach(function (e) { shelf.appendChild(eggRow(e)); });
    }
    setText($("rb-shelf-count"), state.shelf_count + " of " + state.shelf_cap + " shelf spots used. Nests appear on the map as eggs; walk up to one to take it. Eggs you are given land here too.");
  }

  function refreshFlock() {
    return jsonFetch("/api/ramble/flock").then(paintFlock).catch(function () { /* the flock is cosmetic */ });
  }

  /* --------------------------------------------------------------- trades */

  var lastFlock = null;

  function giftableEggs() {
    var eggs = (lastFlock && lastFlock.eggs) || [];
    return eggs.filter(function (e) { return (e.status === "shelf" || e.status === "received") && !e.locked; })
      .map(function (e) { return { label: eggTitle(e), sub: eggSub(e), value: e.egg_id }; });
  }

  function tradeLine(t) {
    var who = t.counterpart_name || t.counterpart;
    var offer = t.offer ? (t.offer.warmth + "% warm" + (t.offer.found_week ? ", found " + t.offer.found_week : "")) : null;
    if (t.state === "proposed" && t.role === "acceptor") return who + " offers an egg" + (offer ? " (" + offer + ")" : "") + ". Pick one of yours to swap.";
    if (t.state === "proposed") return "Waiting for " + who + " to answer.";
    if (t.state === "accepted") return "You answered. Waiting for " + who + " to finish.";
    if (t.state === "completed") return "Swapped with " + who + ".";
    if (t.state === "declined") return "Declined with " + who + ".";
    if (t.state === "expired") return "The offer with " + who + " lapsed.";
    return who;
  }

  function acceptTrade(t, btn) {
    openPicker("Give back which egg?", giftableEggs(), function (eggId) {
      btn.disabled = true;
      jsonFetch("/api/ramble/trades/" + encodeURIComponent(t.trade_id) + "/accept", { method: "POST", body: { egg_id: eggId } })
        .then(function () { setText($("rb-trade-status"), "Answered. The swap finishes when they confirm."); refreshFlock(); return refreshTrades(); })
        .catch(function (err) { setText($("rb-trade-status"), err.message); btn.disabled = false; });
    });
  }

  function declineTrade(t, btn) {
    btn.disabled = true;
    jsonFetch("/api/ramble/trades/" + encodeURIComponent(t.trade_id) + "/decline", { method: "POST", body: {} })
      .then(function () { setText($("rb-trade-status"), t.role === "proposer" ? "Offer withdrawn." : "Declined."); refreshFlock(); return refreshTrades(); })
      .catch(function (err) { setText($("rb-trade-status"), err.message); btn.disabled = false; });
  }

  function tradeRow(t) {
    var row = document.createElement("div");
    row.className = "rb-step" + (t.open ? "" : " rb-muted");
    var badge = document.createElement("span");
    badge.className = "rb-step-n";
    badge.textContent = t.open ? "?" : "·";
    row.appendChild(badge);
    var txt = document.createElement("div");
    txt.className = "rb-step-txt";
    var strong = document.createElement("strong");
    strong.textContent = tradeLine(t);
    var sub = document.createElement("span");
    sub.className = "rb-muted rb-fine";
    sub.textContent = ago(Number(t.updated_at));
    txt.appendChild(strong);
    txt.appendChild(sub);
    row.appendChild(txt);
    if (t.open && t.state === "proposed") {
      var acts = document.createElement("div");
      acts.className = "rb-acts";
      if (t.role === "acceptor") acts.appendChild(shelfAction(t, "Accept", function (b) { acceptTrade(t, b); }));
      acts.appendChild(shelfAction(t, t.role === "proposer" ? "Withdraw" : "Decline", function (b) { declineTrade(t, b); }));
      row.appendChild(acts);
    }
    return row;
  }

  function paintTrades(out) {
    var list = $("rb-trades");
    if (!list) return;
    list.textContent = "";
    var trades = (out && out.trades) || [];
    if (trades.length === 0) {
      var empty = document.createElement("div");
      empty.className = "rb-step";
      var t = document.createElement("div");
      t.className = "rb-step-txt rb-muted";
      t.textContent = "No swaps yet. Use Swap on a shelf egg to offer one.";
      empty.appendChild(t);
      list.appendChild(empty);
      return;
    }
    trades.forEach(function (t) { list.appendChild(tradeRow(t)); });
  }

  function refreshTrades() {
    return jsonFetch("/api/ramble/trades").then(paintTrades).catch(function () { /* cosmetic */ });
  }

  var myFlockBtn = $("rb-my-flock");
  if (myFlockBtn) myFlockBtn.addEventListener("click", function () { showView("flock"); });
  var eggFlockBtn = $("rb-egg-flock");
  if (eggFlockBtn) eggFlockBtn.addEventListener("click", function () { showView("flock"); });
  var flockBirdBtn = $("rb-flock-bird-btn");
  if (flockBirdBtn) flockBirdBtn.addEventListener("click", function () { showView("pet"); });
  var flockBackBtn = $("rb-flock-back");
  if (flockBackBtn) flockBackBtn.addEventListener("click", function () { showView("world"); });

  /* ---------------------------------------------------------------- hatch */

  var shownHatch = null;
  var lastHatched = null;          /* set by handleHatched, read by the beat */

  /**
   * The one hatch entry point: an SSE "ramble-hatched" frame and the "hatched"
   * field on a check-in/unlock response both land here, and the egg id keeps a
   * hatch from playing twice when both arrive.
   */
  function handleHatched(h) {
    if (!h || !h.species || typeof h.seed !== "number") return;
    var key = h.egg_id || (h.species + ":" + h.seed);
    if (key === shownHatch) return;
    shownHatch = key;
    lastHatched = h;
    /* AFTER showView: showView() ends any hatch in progress, so locking first
     * would immediately unlock again when the view actually changes. */
    showView("egg");
    hatchLock = true;
    var stage = $("rb-egg-stage");
    if (stage && !REDUCED) stage.classList.add("rb-hatch");

    setTimeout(function () {
      if (stage) stage.classList.remove("rb-hatch");
      var art = $("rb-egg-art");
      if (art) setHidden(art, true);
      var birdEl = $("rb-hatch-bird");
      if (birdEl && Bird) {
        try {
          Bird.mountBird(birdEl, Bird.rollGenome(h.seed, h.species), "happy");
          setHidden(birdEl, false);
        } catch (e) { /* cosmetic */ }
      }
      var species = Bird && Bird.SPECIES ? Bird.SPECIES[h.species] : null;
      setText($("rb-hatch-name"), "It's a " + ((species && species.name) || h.species) + "!");
      var revealCard = $("rb-hatch-reveal");
      if (revealCard) setHidden(revealCard, false);
      refreshPet();
    }, HATCH_MS);
  }

  /**
   * End the hatch moment and put the egg card back the way it was: unlock the
   * repaint, drop the animation class, hide the reveal and the hatched bird,
   * bring the (now successor) egg art back. Called from showView on ANY view
   * change, so no navigation can strand the egg view mid-reveal.
   */
  function clearHatch() {
    if (!hatchLock) return;
    hatchLock = false;
    var stage = $("rb-egg-stage");
    if (stage) stage.classList.remove("rb-hatch");
    var revealCard = $("rb-hatch-reveal");
    if (revealCard) setHidden(revealCard, true);
    var birdEl = $("rb-hatch-bird");
    if (birdEl) setHidden(birdEl, true);
    var art = $("rb-egg-art");
    if (art) setHidden(art, false);
    refreshEgg();
  }

  var meetBtn = $("rb-meet-bird");
  if (meetBtn) meetBtn.addEventListener("click", function () {
    showView("pet");
    maybeHatchBeat(lastHatched);
  });

  /* ------------------------------------------------------------ prologue */

  function showPrologue(which) {
    var root = $("rb-prologue");
    if (!root) return;
    setHidden($("rb-prologue-intro"), which !== "intro");
    setHidden($("rb-prologue-hatch"), which !== "hatch");
    setHidden(root, false);
  }

  function hidePrologue() { setHidden($("rb-prologue"), true); }

  /* Beat one is for a player who has never had an egg at all — pulled out as
   * a pure function so the gate itself (not just "is it wired at all") is
   * unit-testable, the way nextEggVisibility is above. */
  function shouldShowIntro(p) {
    return !!(p && !p.intro_seen && !p.granted);
  }

  /* There is no backdrop-click or close control — hidePrologue() only runs
   * from the Go button below, whose own handler also marks the intro seen,
   * so skipping the words never costs the egg. */
  function maybeIntro() {
    return jsonFetch("/api/ramble/prologue").then(function (p) {
      if (shouldShowIntro(p)) showPrologue("intro");
    }).catch(function () { /* the prologue is never load-bearing */ });
  }

  var goBtn = $("rb-prologue-go");
  if (goBtn) goBtn.addEventListener("click", function () {
    hidePrologue();
    jsonFetch("/api/ramble/prologue/intro", { method: "POST", body: {} })
      .then(function () { refreshEgg(); refreshPet(); })
      .catch(function () { /* the next load retries */ });
  });

  /* Beat two rides the existing hatch reveal: the bird is already on screen,
   * so this names what just happened rather than interrupting it. */
  function maybeHatchBeat(bird) {
    jsonFetch("/api/ramble/prologue").then(function (p) {
      if (!p || p.hatch_seen) return;
      var lead = $("rb-prologue-hatch-lead");
      if (lead && bird && bird.species) {
        /* Same lookup as handleHatched's reveal line: species is a lowercase
         * key ("blackswan"), never the display name ("Black swan"). */
        var sp = Bird && Bird.SPECIES ? Bird.SPECIES[bird.species] : null;
        setText(lead, "You're out. A " + ((sp && sp.name) || bird.species) +
          " — the only one rolled quite like you.");
      }
      showPrologue("hatch");
    }).catch(function () { /* cosmetic */ });
  }

  var seenBtn = $("rb-prologue-seen");
  if (seenBtn) seenBtn.addEventListener("click", function () {
    hidePrologue();
    jsonFetch("/api/ramble/prologue/hatch", { method: "POST", body: {} })
      .then(function () { showView("pet"); })
      .catch(function () { /* the next load retries */ });
  });

  /* ------------------------------------------------------------------- ar */

  var Ar = window.RambleAr || null;
  var arRoot = $("rb-ar");
  var arSheet = $("rb-ar-sheet");
  var arSession = null;        /* the painter, mounted once */
  var arOpen = false;          /* devices are live */
  var arPose = { lat: null, lon: null, accuracy_m: null, heading: null };
  var arCamera = true;
  var arAnchors = [];
  var arStream = null;
  var arWatch = null;
  var arHeadingEvent = null;   /* which orientation event we listen to */
  var arFetchAt = null;        /* { lat, lon, t } of the last around fetch */
  var arRaf = null;
  var arTick = null;           /* 1 s heartbeat while open: staleness shows even with no events */
  var arHeadingAt = 0;         /* when the last usable heading arrived */
  var AR_REFETCH_M = 50;
  var AR_REFETCH_MS = 60000;
  var AR_HEADING_STALE_MS = 5000;
  var AR_MIN_TURN_DEG = 0.5;   /* orientation events below this do not repaint */
  var AR_NOTICE_KEY = "ramble.ar.limits";

  function arTitle(mark) {
    if (isLocked(mark)) return "A locked mark";
    if (mark.kind === "caw") {
      if (mark.origin === "local" || mark.origin === "sync") return "Your caw";
      if (mark.contact_name) return "A caw from " + mark.contact_name;
      if (mark.author_name) return "A caw from " + mark.author_name + " · " + (mark.author || "anon").slice(0, 4);
      return "A caw";
    }
    var t = String(mark.content_text || "(no text)").trim();
    return t.length > 40 ? t.slice(0, 39) + "…" : t;
  }

  /** Server rows -> the renderer's anchors. lat/lon/accuracy exactly as stored; a locked teaser rides its cell centre with the cell's error radius. */
  function toArAnchors(out) {
    var list = [];
    ((out && out.marks) || []).forEach(function (mark) {
      var exact = typeof mark.lat === "number" && typeof mark.lon === "number";
      var lat = exact ? mark.lat : mark.approx_lat;
      var lon = exact ? mark.lon : mark.approx_lon;
      if (typeof lat !== "number" || typeof lon !== "number") return;
      list.push({
        id: "m:" + mark.mark_id,
        kind: mark.kind === "caw" ? "caw" : "mark",
        lat: lat,
        lon: lon,
        accuracy_m: typeof mark.accuracy_m === "number" ? mark.accuracy_m : null,
        approx_m: exact ? 0 : (typeof mark.approx_m === "number" ? mark.approx_m : 0),
        locked: isLocked(mark),
        reach_m: isLocked(mark) ? UNLOCK_M : null,
        title: arTitle(mark),
        source: mark,
      });
    });
    ((out && out.nests) || []).forEach(function (nest) {
      list.push({
        id: "n:" + nest.cell, kind: "nest", lat: nest.lat, lon: nest.lon, accuracy_m: null, approx_m: 0, locked: false,
        reach_m: CLAIM_M, art: nestArt(nest),
        title: nest.claimed ? "A nest (yours)" : "A nest", source: nest,
      });
    });
    return list;
  }

  function arBirdState() {
    var bird = lastPet && lastPet.bird;
    if (!bird) return null;
    return { species: bird.species, seed: bird.seed, mood: lastPet.mood || "happy" };
  }

  function scheduleArRender() {
    if (!arOpen || !arSession || arRaf) return;
    var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
    arRaf = raf(function () {
      arRaf = null;
      if (!arOpen || !arSession) return;
      /* A compass that stopped reporting (screen lock, sensor hiccup) must not
       * keep placing labels with confidence: a stale heading falls back to the ring. */
      if (arPose.heading != null && Date.now() - arHeadingAt > AR_HEADING_STALE_MS) arPose.heading = null;
      arSession.render({ anchors: arAnchors, pose: arPose, bird: arBirdState(), camera: arCamera, hasEgg: !!eggSeedId });
    });
  }

  function refreshAround() {
    if (!arOpen || typeof arPose.lat !== "number" || typeof arPose.lon !== "number") return Promise.resolve();
    arFetchAt = { lat: arPose.lat, lon: arPose.lon, t: Date.now() };
    /* toFixed(6) is ~0.1 m: enough for a label, and never a 400 from a long double. */
    return jsonFetch("/api/ramble/around?lat=" + encodeURIComponent(arPose.lat.toFixed(6)) + "&lon=" + encodeURIComponent(arPose.lon.toFixed(6)))
      .then(function (out) {
        /* toArAnchors's mark loop builds id: "m:" + mark.mark_id and its nest
         * loop builds id: "n:" + nest.cell plus art: nestArt(nest) — a beacon
         * has none of mark_id, cell or seed, so both arrays are filtered here,
         * before toArAnchors ever sees a beacon. */
        var filtered = {
          marks: ((out && out.marks) || []).filter(function (m) { return !m.beacon; }),
          nests: ((out && out.nests) || []).filter(function (n) { return !n.beacon; }),
        };
        arAnchors = toArAnchors(filtered);
        scheduleArRender();
      })
      .catch(function () { arFetchAt = null; /* keep the last anchors; the pose still moves them */ });
  }

  function maybeRefreshAround() {
    if (!arFetchAt) { refreshAround(); return; }
    var moved = haversineMeters({ lat: arFetchAt.lat, lon: arFetchAt.lon }, { lat: arPose.lat, lon: arPose.lon });
    if (moved >= AR_REFETCH_M || Date.now() - arFetchAt.t >= AR_REFETCH_MS) refreshAround();
  }

  function screenAngle() {
    try {
      if (window.screen && window.screen.orientation && typeof window.screen.orientation.angle === "number") return window.screen.orientation.angle;
      if (typeof window.orientation === "number") return window.orientation;
    } catch (e) { /* not fatal */ }
    return 0;
  }

  function onArOrientation(ev) {
    var h = Ar.headingFromEvent(ev, screenAngle());
    if (h == null) return;
    arHeadingAt = Date.now();
    var next = Ar.smoothHeading(arPose.heading, h, 0.3);
    /* Orientation fires at up to 60 Hz; a sub-degree wobble is not a repaint. */
    if (arPose.heading != null && Math.abs(Ar.relativeBearing(next, arPose.heading)) < AR_MIN_TURN_DEG) return;
    arPose.heading = next;
    scheduleArRender();
  }

  function startArHeading() {
    /* Absolute orientation where the platform has it; iOS reports webkitCompassHeading on the plain event. */
    arHeadingEvent = ("ondeviceorientationabsolute" in window) ? "deviceorientationabsolute" : "deviceorientation";
    window.addEventListener(arHeadingEvent, onArOrientation);
  }

  function stopArHeading() {
    if (!arHeadingEvent) return;
    window.removeEventListener(arHeadingEvent, onArOrientation);
    arHeadingEvent = null;
  }

  /** iOS 13+: orientation events need a permission granted from a user gesture. Resolves either way — a refusal is the radar strip. */
  function requestArMotion() {
    try {
      if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === "function") {
        return DeviceOrientationEvent.requestPermission().catch(function () { return "denied"; });
      }
    } catch (e) { /* fall through */ }
    return Promise.resolve("granted");
  }

  /** restart = a return from a hidden tab: a camera that worked a second ago gets one retry before the view gives up on it. */
  function startArCamera(restart) {
    var video = $("rb-ar-video");
    if (!video || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      arCamera = false;
      scheduleArRender();
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then(function (stream) {
        if (!arOpen || document.hidden) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        if (arStream) { arStream.getTracks().forEach(function (t) { t.stop(); }); }
        arStream = stream;
        video.srcObject = stream;
        var p = video.play();
        if (p && typeof p.catch === "function") p.catch(function () { /* autoplay policy: the frame still paints */ });
        arCamera = true;
        scheduleArRender();
      })
      .catch(function () {
        if (restart === true && arOpen) { setTimeout(function () { if (arOpen && !arStream && !document.hidden) startArCamera(false); }, 1500); return; }
        arCamera = false;
        scheduleArRender();
      });
  }

  function stopArCamera() {
    var video = $("rb-ar-video");
    if (arStream) { arStream.getTracks().forEach(function (t) { t.stop(); }); arStream = null; }
    if (video) { try { video.srcObject = null; } catch (e) { /* not fatal */ } }
  }

  function startArGps() {
    if (lastFix) {
      arPose.lat = lastFix.lat; arPose.lon = lastFix.lon; arPose.accuracy_m = lastFix.accuracy_m;
      refreshAround();
      scheduleArRender();
    }
    if (mapWatch != null) return; /* the map's watch feeds arPose while the view is open */
    if (!navigator.geolocation) return;
    arWatch = navigator.geolocation.watchPosition(function (pos) {
      lastFix = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy_m: pos.coords.accuracy };
      arPose.lat = lastFix.lat; arPose.lon = lastFix.lon; arPose.accuracy_m = lastFix.accuracy_m;
      maybeRefreshAround();
      scheduleArRender();
    }, function (err) {
      /* Permission pulled mid-session (code 1): the old fix is a lie now — back to "Waiting for a fix…". A timeout keeps the last fix. */
      if (err && err.code === 1) { arPose.lat = null; arPose.lon = null; arAnchors = []; }
      scheduleArRender();
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  }

  function stopArGps() {
    if (arWatch == null || !navigator.geolocation) { arWatch = null; return; }
    try { navigator.geolocation.clearWatch(arWatch); } catch (e) { /* gone */ }
    arWatch = null;
  }

  function arElements() {
    return {
      root: arRoot, labels: $("rb-ar-labels"), radar: $("rb-ar-ring"), list: $("rb-ar-list"), coarse: $("rb-ar-coarse"),
      bird: $("rb-ar-bird"), egg: $("rb-ar-egg"), say: $("rb-ar-say"), more: $("rb-ar-more"), mode: $("rb-ar-mode-label"),
    };
  }

  /** A label tap = the pin's own popup, in a sheet. */
  function onArTap(id) {
    var anchor = arSession && arSession.anchor(id);
    if (!anchor || !anchor.source) return;
    openArSheet(anchor.kind === "nest" ? nestPopup(anchor.source) : popupFor(anchor.source));
  }

  function openArSheet(node) {
    var body = $("rb-ar-sheet-body");
    if (!arSheet || !body) return;
    body.textContent = "";
    body.appendChild(node);
    setHidden(arSheet, false);
  }

  function closeArSheet() {
    if (!arSheet || arSheet.hidden) return;
    setHidden(arSheet, true);
    var body = $("rb-ar-sheet-body");
    if (body) body.textContent = "";
    /* An unlock or a claim may have changed what is around. */
    refreshAround();
  }

  /* Once a second while open: a failed around fetch (arFetchAt cleared) is
   * retried as soon as there is a fix, not only on the next position event. */
  function arHeartbeat() {
    if (arOpen && !arFetchAt && typeof arPose.lat === "number") refreshAround();
    scheduleArRender();
  }

  /**
   * Devices start HERE, synchronously inside the user's click: getUserMedia and
   * DeviceOrientationEvent.requestPermission both want transient activation, so
   * the camera prompt is issued first and the motion prompt right after it in
   * the same handler (Q2) — never after an awaited promise.
   */
  function startAr() {
    if (!Ar || !arRoot) return;
    if (arOpen) return;
    arOpen = true;
    setHidden(arRoot, false);
    if (!arSession) arSession = Ar.mountAr(arElements(), { engine: Bird, onTap: onArTap });
    drawEggArt($("rb-ar-egg"), eggSeedId);
    arPose = { lat: null, lon: null, accuracy_m: null, heading: null };
    arHeadingAt = 0;
    arCamera = true;
    arAnchors = [];
    arFetchAt = null;
    scheduleArRender();
    startArCamera();
    requestArMotion().then(function () { if (arOpen) startArHeading(); });
    startArGps();
    if (!arTick) arTick = setInterval(arHeartbeat, 1000);
    refreshPet();
  }

  function closeAr() {
    arOpen = false;
    closeArSheet();
    stopArCamera();
    stopArGps();
    stopArHeading();
    if (arTick) { clearInterval(arTick); arTick = null; }
    if (arRaf) { try { (window.cancelAnimationFrame || clearTimeout)(arRaf); } catch (e) { /* not fatal */ } arRaf = null; }
    if (arSession) arSession.destroy();
    nestArtCache = {};
    var notice = $("rb-ar-notice");
    if (notice) setHidden(notice, true);
    if (arRoot) setHidden(arRoot, true);
  }

  function arStorage() { return window.localStorage; }
  function arNoticeSeen() { return Ar.noticeSeen(arStorage, AR_NOTICE_KEY); }
  function markArNoticeSeen() { Ar.markNoticeSeen(arStorage, AR_NOTICE_KEY); }

  /** The chip. First time: the notice, and NOTHING starts until "Got it". After that: the devices, from the click itself. */
  function openAr() {
    if (!Ar || !arRoot) return;
    var notice = $("rb-ar-notice");
    if (!arNoticeSeen() && notice) {
      setHidden(notice, false);
      setHidden(arRoot, false);
      return;
    }
    startAr();
  }

  var arChip = $("rb-chip-ar");
  if (arChip) {
    if (!Ar) setHidden(arChip, true);
    /* openAr runs synchronously in the click so the device prompts keep the gesture. */
    arChip.addEventListener("click", function () { if (!arOpen) openAr(); });
  }
  var arClose = $("rb-ar-close");
  if (arClose) arClose.addEventListener("click", closeAr);
  var arGotIt = $("rb-ar-gotit");
  if (arGotIt) {
    arGotIt.addEventListener("click", function () {
      markArNoticeSeen();
      var notice = $("rb-ar-notice");
      if (notice) setHidden(notice, true);
      startAr();
    });
  }
  var arSheetClose = $("rb-ar-sheet-close");
  if (arSheetClose) arSheetClose.addEventListener("click", closeArSheet);
  if (arSheet) arSheet.addEventListener("click", function (ev) { if (ev.target === arSheet) closeArSheet(); });
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    if (arSheet && !arSheet.hidden) { closeArSheet(); return; }
    if (arRoot && !arRoot.hidden) closeAr();
  });
  /* A backgrounded tab must not keep the camera; coming back restarts it in place (Q3 — the view stays open). */
  document.addEventListener("visibilitychange", function () {
    if (!arOpen) return;
    if (document.hidden) { stopArCamera(); return; }
    startArCamera(true);
  });

  /* --------------------------------------------------- nearby live updates */

  try {
    var stream = new EventSource("/dashboard/streams/ramble-nearby");
    /* The server sends NAMED frames ("event: ramble-nearby"), and onmessage
       only ever fires for UNNAMED ones -- it must be addEventListener. */
    stream.addEventListener("ramble-nearby", function () { refreshMarks(); refreshPet(); if (arOpen) refreshAround(); });
    stream.addEventListener("ramble-hatched", function (ev) {
      var payload = null;
      try { payload = JSON.parse(ev.data); } catch (e) { payload = null; }
      refreshPet();
      handleHatched(payload);
    });
    stream.addEventListener("ramble-nest-claimed", function () { refreshNestsAfterPop(); refreshFlock(); if (arOpen) refreshAround(); });
    stream.addEventListener("ramble-trade", function () { refreshFlock(); refreshTrades(); });
    stream.onerror = function () { /* quiet: the stream may not exist yet */ };
  } catch (err) { /* no EventSource, no live updates */ }

  /* --------------------------------------------------------------- startup */

  jsonFetch("/api/ramble/grid").then(paintGrid).catch(function () { /* leave the chip at off */ });
  refreshContacts();
  refreshEgg().then(refreshPet);
  maybeIntro();

  if (map) {
    startMapWatch();
    /* The markup ships the chip lit; nothing follows until the first fix says so. */
    setFollowing(false);
    here().then(function (pos) {
      map.setView([pos.lat, pos.lon], WALK_ZOOM);
      paintHere(pos);
      setFollowing(true);
    }).catch(function () {
      /* The ONLY thing the strip line still says. There is no marker without a
       * fix, so the bird has no mouth to say it with — and this is a standing
       * condition, not a moment, so it stays until a fix arrives. */
      var say = $("rb-perch-say");
      if (say) { setText(say, "Pan the map to pick where you are listening."); setHidden(say, false); }
    }).then(function () { publishArea(); refreshNests(); refreshZones(); });
    setInterval(refreshNests, 10 * 60e3);
    setInterval(refreshZones, 10 * 60e3);
  }
})();
