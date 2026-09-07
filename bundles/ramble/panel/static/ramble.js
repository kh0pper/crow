/* Ramble panel client. Plain script (no modules, no bundler); served from
 * /ramble/static/ramble.js behind dashboardAuth.
 *
 * NO TEMPLATE LITERALS anywhere in this file -- panel scripts are handled by
 * tooling that treats backticks as its own delimiter; string concatenation is
 * the house style here. Remote content is written with textContent only, never
 * innerHTML: marks arrive from other people's personas.
 *
 * CSRF is handled for us -- the dashboard layout wraps window.fetch and adds
 * X-Crow-Csrf to every state-changing same-origin request.
 */
(function () {
  "use strict";

  var mapEl = document.getElementById("ramble-map");
  if (!mapEl || typeof L === "undefined") return;

  var DEFAULT_CENTER = [20, 0];
  var DEFAULT_ZOOM = 3;
  var LOCATED_ZOOM = 15;

  var statusEl = document.getElementById("ramble-map-status");
  var composeStatusEl = document.getElementById("rb-compose-status");
  var gridStatusEl = document.getElementById("rb-grid-status");
  var marksListEl = document.getElementById("ramble-marks");
  var petEl = document.getElementById("ramble-pet");

  var currentCells = [];
  var markerLayer = null;

  function setText(el, text) { if (el) el.textContent = text; }

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

  /* ------------------------------------------------------------------ map */

  L.Icon.Default.imagePath = "/ramble/static/leaflet/images/";

  /* Tiles come from our OWN origin: the dashboard CSP is
   * img-src 'self' data: blob:, so a third-party tile host would be blocked.
   * /ramble/tiles proxies whatever ramble_settings.tile_url points at, which
   * also keeps the viewer's browser from ever talking to the tile host. */
  var map = L.map(mapEl).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  L.tileLayer("/ramble/tiles/{z}/{x}/{y}.png", {
    attribution: mapEl.getAttribute("data-tile-attribution") || "",
    maxZoom: 19,
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);

  function here() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) { reject(new Error("this browser has no geolocation")); return; }
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          resolve({
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy_m: pos.coords.accuracy,
          });
        },
        function (err) { reject(new Error(err.message || "location unavailable")); },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
      );
    });
  }

  /* ---------------------------------------------------------------- marks */

  function markLabel(mark) {
    var who = (mark.author || "anon").slice(0, 8);
    var what = mark.kind === "caw" ? "caw" : "mark";
    return what + " by " + who;
  }

  function isLocked(mark) {
    return mark.reveal === "locked" && typeof mark.content_text !== "string";
  }

  function popupFor(mark) {
    var box = document.createElement("div");
    var head = document.createElement("strong");
    head.textContent = markLabel(mark);
    box.appendChild(head);
    var body = document.createElement("p");
    body.style.margin = "0.35rem 0 0";
    if (isLocked(mark)) {
      body.textContent = "Locked — the text only opens within about " +
        Math.round(mark.approx_m || 0) + " m of the real spot.";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Unlock here";
      btn.addEventListener("click", function () { unlock(mark, body, btn); });
      box.appendChild(body);
      box.appendChild(btn);
      return box;
    }
    body.textContent = mark.content_text || "(no text)";
    box.appendChild(body);
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
    }).catch(function (err) {
      bodyEl.textContent = err.message;
      btn.disabled = false;
    });
  }

  function drawMarks(marks) {
    markerLayer.clearLayers();
    if (marksListEl) marksListEl.textContent = "";
    marks.forEach(function (mark) {
      if (typeof mark.lat === "number" && typeof mark.lon === "number") {
        /* An open mark publishes its real anchor: a normal pin. */
        var marker = L.marker([mark.lat, mark.lon], { title: markLabel(mark) });
        marker.bindPopup(popupFor(mark));
        marker.addTo(markerLayer);
      } else if (typeof mark.approx_lat === "number" && typeof mark.approx_lon === "number") {
        /* A locked teaser has no anchor -- only the coarse cell the server
         * decoded for us. Draw it as a dashed circle at the cell centre so it
         * reads as "somewhere in here", never as a precise point. */
        var radius = Math.max(12, Math.min(60, (mark.approx_m || 0) / 40));
        var blob = L.circleMarker([mark.approx_lat, mark.approx_lon], {
          radius: radius,
          color: "#b45309",
          weight: 2,
          dashArray: "4 3",
          fillOpacity: 0.12,
        });
        blob.bindPopup(popupFor(mark));
        blob.addTo(markerLayer);
      }
      if (marksListEl) {
        var li = document.createElement("li");
        li.textContent = markLabel(mark) + " — " +
          (isLocked(mark) ? "locked, go there to reveal" : (mark.content_text || "(no text)"));
        marksListEl.appendChild(li);
      }
    });
    if (marksListEl && marks.length === 0) {
      var empty = document.createElement("li");
      empty.className = "rb-muted";
      empty.textContent = "Nothing here yet.";
      marksListEl.appendChild(empty);
    }
  }

  function refreshMarks() {
    if (currentCells.length === 0) return Promise.resolve();
    return jsonFetch("/api/ramble/marks?visibility=public&cells=" +
      encodeURIComponent(currentCells.join(","))
    ).then(function (body) {
      drawMarks((body && body.marks) || []);
    }).catch(function (err) { setText(statusEl, err.message); });
  }

  /* The active area is the subscriber's only input: post it when the view
   * settles, then redraw from whatever cells the server says that is. */
  function publishArea() {
    var c = map.getCenter();
    return jsonFetch("/api/ramble/area", { method: "POST", body: { lat: c.lat, lon: c.lng } })
      .then(function (body) {
        currentCells = (body && body.cells) || [];
        setText(statusEl, "Listening to " + currentCells.join(", "));
        return refreshMarks();
      })
      .catch(function (err) { setText(statusEl, err.message); });
  }

  var areaTimer = null;
  map.on("moveend", function () {
    if (areaTimer) clearTimeout(areaTimer);
    areaTimer = setTimeout(publishArea, 500);
  });

  /* -------------------------------------------------------------- compose */

  function compose(kind) {
    var textEl = document.getElementById("rb-text");
    var text = textEl ? textEl.value : "";
    if (!text.trim()) { setText(composeStatusEl, "Write something first."); return; }
    setText(composeStatusEl, "Finding you…");
    here().then(function (pos) {
      var visEl = document.getElementById("rb-visibility");
      var revEl = document.getElementById("rb-reveal");
      var body = {
        kind: kind,
        lat: pos.lat,
        lon: pos.lon,
        accuracy_m: pos.accuracy_m,
        text: text,
      };
      if (kind === "mark") {
        body.visibility = visEl ? visEl.value : "public";
        body.reveal = revEl ? revEl.value : "locked";
      }
      return jsonFetch("/api/ramble/marks", { method: "POST", body: body });
    }).then(function () {
      if (textEl) textEl.value = "";
      setText(composeStatusEl, "Stored and queued — the transport decides what actually goes out.");
      return refreshMarks();
    }).catch(function (err) { setText(composeStatusEl, err.message); });
  }

  var leaveBtn = document.getElementById("rb-leave-mark");
  if (leaveBtn) leaveBtn.addEventListener("click", function () { compose("mark"); });
  var cawBtn = document.getElementById("rb-caw");
  if (cawBtn) cawBtn.addEventListener("click", function () { compose("caw"); });

  /* ----------------------------------------------------------------- grid */

  var masterEl = document.getElementById("rb-master");
  var identityEl = document.getElementById("rb-identity");
  var cellEls = Array.prototype.slice.call(document.querySelectorAll(".rb-grid-cell"));

  function paintGrid(grid) {
    if (!grid) return;
    if (masterEl) masterEl.checked = !!grid.master;
    if (identityEl && grid.identityLevel) identityEl.value = grid.identityLevel;
    cellEls.forEach(function (el) {
      var row = grid.cells && grid.cells[el.getAttribute("data-audience")];
      el.checked = !!(row && row[el.getAttribute("data-channel")]);
    });
  }

  function postGrid(body) {
    setText(gridStatusEl, "Saving…");
    jsonFetch("/api/ramble/grid", { method: "POST", body: body })
      .then(function (grid) { paintGrid(grid); setText(gridStatusEl, "Saved."); })
      .catch(function (err) { setText(gridStatusEl, err.message); });
  }

  if (masterEl) masterEl.addEventListener("change", function () { postGrid({ master: masterEl.checked }); });
  if (identityEl) identityEl.addEventListener("change", function () { postGrid({ identityLevel: identityEl.value }); });
  cellEls.forEach(function (el) {
    el.addEventListener("change", function () {
      var cells = {};
      cells[el.getAttribute("data-audience")] = {};
      cells[el.getAttribute("data-audience")][el.getAttribute("data-channel")] = el.checked;
      postGrid({ cells: cells });
    });
  });

  jsonFetch("/api/ramble/grid").then(paintGrid).catch(function (err) { setText(gridStatusEl, err.message); });

  /* ------------------------------------------------------------------ pet */

  jsonFetch("/api/ramble/pet").then(function (pet) {
    if (!petEl || !pet) return;
    petEl.textContent = "";
    var face = document.createElement("div");
    face.textContent = "🐦";
    var line = document.createElement("div");
    line.className = "rb-pet-line";
    line.textContent = (pet.mood || "?") + " · energy " + (pet.energy != null ? pet.energy : "?");
    petEl.appendChild(face);
    petEl.appendChild(line);
  }).catch(function () { /* pet is cosmetic */ });

  /* --------------------------------------------------- nearby live updates */
  /* Task 13 adds the server side; until then a 404 must be silent. */
  try {
    var stream = new EventSource("/dashboard/streams/ramble-nearby");
    stream.onmessage = function () { refreshMarks(); };
    stream.onerror = function () { /* quiet: the stream may not exist yet */ };
  } catch (err) { /* no EventSource, no live updates */ }

  /* --------------------------------------------------------------- startup */

  here().then(function (pos) {
    map.setView([pos.lat, pos.lon], LOCATED_ZOOM);
  }).catch(function () {
    setText(statusEl, "Location unavailable — pan the map to choose an area.");
  }).then(publishArea);
})();
