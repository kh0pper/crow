/**
 * Crow's Nest Panel — Frigate: cameras with live stills, recent events, system stats,
 * and a link to Frigate's own web UI.
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 *
 * Overview tab: REST-driven via /api/frigate/* routes (bundles/frigate/panel/routes.js).
 * The camera list is read once here, server-side, so every card carries a still in the
 * first paint; the browser then refreshes each still every two seconds through the same
 * gateway route, so Frigate's JWT never leaves the gateway process. The gateway's still
 * route builds its upstream path itself and forwards no query parameters, so a
 * downscale hint such as ?h=360 would be dropped — the panel asks for the still as-is
 * and appends only a cache-busting `t`.
 *
 * Web UI tab: a link to FRIGATE_UI_URL that opens in a new tab. Frigate's own UI is not
 * embedded: its address is a loopback one only this server can reach (a phone resolves
 * "localhost" to itself), and a cross-origin frame is also blocked by the dashboard's
 * frame-ancestors policy.
 *
 * Client-side JS uses DOM construction (createElement + textContent + appendChild) so
 * there is no innerHTML assignment with dynamic content. It is emitted inside a
 * template literal — never put a backtick in it. Turbo Drive re-runs this script on
 * every visit, so each instance adopts one window slot (window.__fgStills), stops the
 * previous instance and drops its listeners: one still timer per page, not one per visit.
 * The slot also stops the timer when Turbo caches the page or starts a visit.
 */

/** How long the Overview waits for Frigate's camera list before drawing the empty shell. */
const CAMERA_LIST_BUDGET_MS = 2000;

export default {
  id: "frigate",
  name: "Frigate",
  icon: "phone-video",
  route: "/dashboard/frigate",
  navOrder: 32,
  category: "cameras",

  async handler(req, res, { layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");

    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    const tab = req.query.tab || "overview";

    const tabs = [
      { id: "overview", label: "Overview" },
      { id: "webui", label: "Web UI" },
    ];

    const tabBar = `<div class="fg-tabs">${tabs.map((t) =>
      `<a href="?tab=${escapeHtml(t.id)}" class="fg-tab${tab === t.id ? " active" : ""}">${escapeHtml(t.label)}</a>`
    ).join("")}</div>`;

    let body = "";
    if (tab === "webui") {
      body = renderWebUI(browserUiUrl(), escapeHtml);
    } else {
      body = renderOverview(await readCameras(appRoot), escapeHtml);
    }

    const content = `
      <style>${frigateStyles()}</style>
      <div class="fg-panel">
        <h1>Frigate NVR</h1>
        ${tabBar}
        <div class="fg-body">${body}</div>
      </div>
      <script>${frigateScript()}</script>
    `;

    res.send(layout({ title: "Frigate", content }));
  },
};

/**
 * The address this browser uses for Frigate's own UI (manifest env var FRIGATE_UI_URL).
 * Only http(s) is accepted: a link is rendered from it, and any other scheme would let a
 * stored value run script in the dashboard. A blank or unusable value hides the link.
 */
function browserUiUrl() {
  const raw = String(process.env.FRIGATE_UI_URL || "").trim();
  if (!raw) return null;
  try {
    const scheme = new URL(raw).protocol;
    if (scheme !== "http:" && scheme !== "https:") return null;
  } catch {
    return null;
  }
  return raw;
}

/** The gateway's still route for one camera (panel/routes.js). The name is URL-encoded. */
function stillSrc(name) {
  return `/api/frigate/${encodeURIComponent(String(name == null ? "" : name))}/latest.jpg`;
}

/**
 * This bundle's own Frigate client. A panel file runs from <CROW_HOME>/panels/<id>.js when
 * installed and from bundles/<id>/panel/ in a checkout, so its own code is loaded by path:
 * this instance's installed copy first, then the app's own copy.
 */
async function loadBundleClient(appRoot) {
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const { pathToFileURL } = await import("node:url");

  const home = process.env.CROW_HOME || join(homedir(), ".crow");
  const candidates = [join(home, "bundles", "frigate", "server", "frigate-api.js")];
  if (appRoot) candidates.push(join(appRoot, "bundles", "frigate", "server", "frigate-api.js"));

  for (const path of candidates) {
    try {
      return await import(pathToFileURL(path).href);
    } catch {
      // try the next copy
    }
  }
  return null;
}

/** Frigate's /api/config camera map, mapped the way panel/routes.js maps it. */
function camerasFromConfig(config) {
  const map = config && typeof config === "object" ? config.cameras : null;
  if (!map || typeof map !== "object") return [];
  return Object.entries(map).map(([name, cam]) => ({
    name,
    enabled: !cam || cam.enabled !== false,
    detect_enabled: !cam || cam.detect?.enabled !== false,
    width: cam?.detect?.width || null,
    height: cam?.detect?.height || null,
    tracked_objects: Array.isArray(cam?.objects?.track) ? cam.objects.track : [],
  }));
}

/**
 * The camera list for the first paint. Returns null when it could not be read inside the
 * budget (Frigate down, no credentials yet): the browser then fills the grid from
 * /api/frigate/cameras, which reports the real error on the page.
 */
async function readCameras(appRoot) {
  const client = await loadBundleClient(appRoot);
  if (!client || typeof client.frigateFetch !== "function") return null;
  let timer = null;
  try {
    const config = await Promise.race([
      Promise.resolve().then(() => client.frigateFetch("/api/config")),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("camera list timed out")), CAMERA_LIST_BUDGET_MS);
        try { timer?.unref?.(); } catch { /* a test's timer need not support unref */ }
      }),
    ]);
    return camerasFromConfig(config);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One card per camera: the current still, its name, and what Frigate is detecting on it. */
function cameraCards(cameras, escapeHtml) {
  if (!cameras || cameras.length === 0) {
    return `<div class="fg-empty">No cameras configured. Edit config.yml to add RTSP sources.</div>`;
  }
  return cameras.map((camera) => {
    const name = String(camera.name == null ? "" : camera.name);
    const resolution = camera.width && camera.height ? `${camera.width}×${camera.height}` : "?";
    const tracked = (camera.tracked_objects || []).join(", ") || "none";
    const detect = camera.detect_enabled ? "detect" : "detect off";
    return `
      <div class="fg-camera">
        <img class="fg-cam-img" data-cam="${escapeHtml(name)}" src="${escapeHtml(stillSrc(name))}" alt="${escapeHtml(name)}" loading="lazy">
        <div class="fg-camera-name">${escapeHtml(name)}</div>
        <div class="fg-camera-meta"><span class="fg-badge ${camera.detect_enabled ? "on" : "off"}">${detect}</span> ${escapeHtml(resolution)}</div>
        <div class="fg-camera-meta">tracking: ${escapeHtml(tracked)}</div>
      </div>`;
  }).join("");
}

function renderOverview(cameras, escapeHtml) {
  const cards = cameras === null
    ? `<div class="fg-loading">Loading cameras…</div>`
    : cameraCards(cameras, escapeHtml);

  return `
    <div class="fg-overview">
      <div class="fg-section">
        <h3>Cameras</h3>
        <div id="fg-cameras" class="fg-cameras">
          ${cards}
        </div>
      </div>
      <div class="fg-section">
        <h3>Recent Events</h3>
        <div id="fg-events" class="fg-events">
          <div class="fg-loading">Loading events…</div>
        </div>
      </div>
      <div class="fg-section">
        <h3>System</h3>
        <pre id="fg-stats" class="fg-stats">Loading stats…</pre>
      </div>
    </div>
  `;
}

/**
 * The Web UI tab. Frigate's UI lives on a loopback address only the server can reach, so
 * this page never embeds it and never prints that address: with FRIGATE_UI_URL set, it
 * offers a link to the address the browser uses, and otherwise says how to set one. The
 * link carries the whole stored URL; the visible text is only its origin, so credentials
 * or a path in that setting are never echoed onto the page.
 */
function renderWebUI(uiUrl, escapeHtml) {
  const heading = `<h3>Frigate's own web UI</h3>`;
  if (!uiUrl) {
    return `
      <div class="fg-webui">
        ${heading}
        <p>Frigate's full interface (recordings, clips, zones, detector settings) runs on this server's own loopback address, which your browser cannot open.</p>
        <p>To reach it from your phone or another device, set <code>FRIGATE_UI_URL</code> in this extension's settings to the address your browser uses for Frigate — for example a Tailscale Serve HTTPS URL — then reload this page.</p>
      </div>
    `;
  }
  return `
    <div class="fg-webui">
      ${heading}
      <p>Frigate's full interface (recordings, clips, zones, detector settings) opens in a new tab.</p>
      <a class="fg-webui-link" href="${escapeHtml(uiUrl)}" target="_blank" rel="noopener">Open Frigate</a>
      <p class="fg-camera-meta">${escapeHtml(publicOrigin(uiUrl))}</p>
    </div>
  `;
}

/**
 * The only part of FRIGATE_UI_URL the page prints: scheme and host. A stored value may carry
 * credentials or a path, and neither belongs on a page the owner reads over a shoulder.
 */
function publicOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function frigateStyles() {
  return `
    .fg-panel { max-width: 1100px; margin: 0 auto; padding: 1rem; }
    .fg-tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--border, #333); margin-bottom: 1rem; }
    .fg-tab { padding: 0.5rem 1rem; text-decoration: none; color: var(--muted, #888); border-bottom: 2px solid transparent; }
    .fg-tab.active { color: var(--fg, #fff); border-bottom-color: var(--accent, #d9a521); }
    .fg-section { margin: 1.5rem 0; }
    .fg-section h3 { margin: 0 0 0.5rem; font-size: 1rem; color: var(--muted, #888); text-transform: uppercase; letter-spacing: 0.05em; }
    .fg-cameras { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 0.75rem; }
    .fg-camera { padding: 0.75rem; background: var(--panel, #1a1a1a); border: 1px solid var(--border, #333); border-radius: 6px; }
    .fg-cam-img { width: 100%; aspect-ratio: 16/9; object-fit: cover; background: #000; border-radius: 4px; display: block; margin-bottom: 0.5rem; }
    .fg-camera-name { font-weight: 600; margin-bottom: 0.25rem; }
    .fg-camera-meta { font-size: 0.85rem; color: var(--muted, #888); }
    .fg-badge { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.75rem; margin-right: 0.25rem; }
    .fg-badge.on { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
    .fg-badge.off { background: rgba(148, 163, 184, 0.2); color: #94a3b8; }
    .fg-badge.person { background: rgba(59, 130, 246, 0.2); color: #3b82f6; }
    .fg-badge.car { background: rgba(251, 146, 60, 0.2); color: #fb923c; }
    .fg-badge.dog, .fg-badge.cat, .fg-badge.animal { background: rgba(168, 85, 247, 0.2); color: #a855f7; }
    .fg-events { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.75rem; }
    .fg-event { background: var(--panel, #1a1a1a); border: 1px solid var(--border, #333); border-radius: 6px; overflow: hidden; }
    .fg-event-thumb { width: 100%; aspect-ratio: 16/9; object-fit: cover; background: #000; display: block; }
    .fg-event-body { padding: 0.5rem 0.75rem; font-size: 0.85rem; }
    .fg-event-camera { color: var(--muted, #888); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .fg-event-time { color: var(--muted, #888); font-size: 0.75rem; margin-top: 0.2rem; }
    .fg-stats { padding: 0.75rem; background: var(--panel, #1a1a1a); border: 1px solid var(--border, #333); border-radius: 6px; font-family: monospace; font-size: 0.85rem; white-space: pre-wrap; margin: 0; }
    .fg-loading { color: var(--muted, #888); font-style: italic; grid-column: 1 / -1; }
    .fg-empty { color: var(--muted, #888); font-style: italic; grid-column: 1 / -1; }
    .fg-error { color: #f43f5e; grid-column: 1 / -1; }
    .fg-webui { max-width: 40rem; }
    .fg-webui h3 { margin: 0 0 0.5rem; font-size: 1rem; }
    .fg-webui p { color: var(--muted, #888); line-height: 1.5; }
    .fg-webui code { font-family: monospace; }
    .fg-webui-link { display: inline-block; margin: 0.5rem 0; padding: 0.5rem 1rem; border-radius: 6px; background: var(--accent, #d9a521); color: #111; font-weight: 600; text-decoration: none; }
  `;
}

function frigateScript() {
  return `
    (function () {
      var STILL_REFRESH_MS = 2000;

      // Turbo re-runs this script on every visit, so a second visit must not stack a second
      // timer and a second listener: the previous instance in the window slot is stopped and
      // its listeners are dropped before this one installs.
      var previous = window.__fgStills;
      if (previous && typeof previous.stop === "function") {
        previous.stop();
        if (previous.onVisibility) document.removeEventListener("visibilitychange", previous.onVisibility);
        if (previous.onPageLeave) {
          document.removeEventListener("turbo:before-cache", previous.onPageLeave);
          document.removeEventListener("turbo:before-visit", previous.onPageLeave);
        }
      }

      var stillTimer = null;
      // Camera name to a load still in flight: a tick skips that camera until it settles.
      var stillBusy = {};

      // This instance's slot on window; the next visit reads it to stop this one.
      var state = { stop: stopStills, onVisibility: onVisibilityChange, onPageLeave: onPageLeave };
      window.__fgStills = state;

      function clearKids(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
      function span(cls, text) { var s = document.createElement("span"); s.className = cls; s.textContent = text; return s; }
      function div(cls, text) { var d = document.createElement("div"); d.className = cls; if (text != null) d.textContent = text; return d; }
      function el(tag, cls, text) { var x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; }
      function relTime(secs) {
        if (!secs) return "";
        var d = Math.floor(Date.now() / 1000 - secs);
        if (d < 60) return d + "s ago";
        if (d < 3600) return Math.floor(d / 60) + "m ago";
        if (d < 86400) return Math.floor(d / 3600) + "h ago";
        return Math.floor(d / 86400) + "d ago";
      }
      function labelCls(label) {
        var l = (label || "").toLowerCase();
        if (["person","face"].indexOf(l) >= 0) return "fg-badge person";
        if (["car","truck","motorcycle","bicycle"].indexOf(l) >= 0) return "fg-badge car";
        if (["dog","cat","bird","animal","horse","sheep","cow"].indexOf(l) >= 0) return "fg-badge dog";
        return "fg-badge on";
      }

      // The gateway's still route, with the camera name URL-encoded.
      function stillSrc(name) {
        return "/api/frigate/" + encodeURIComponent(name) + "/latest.jpg";
      }

      function cameraStill(name) {
        var img = document.createElement("img");
        img.className = "fg-cam-img";
        img.loading = "lazy";
        img.alt = name;
        img.setAttribute("data-cam", name);
        img.onerror = function () { this.style.display = "none"; };
        img.src = stillSrc(name);
        return img;
      }

      // Fetch the next still off-screen and swap it in only once it has loaded, so the
      // card never flashes while it refreshes.
      function refreshStill(img) {
        var name = img.getAttribute("data-cam");
        if (!name) return;
        if (stillBusy[name]) return;  // the previous still for this camera has not settled
        stillBusy[name] = true;
        var next = new Image();
        next.onload = function () {
          img.style.display = "";
          img.src = next.src;
          stillBusy[name] = false;
        };
        next.onerror = function () { stillBusy[name] = false; };
        next.src = stillSrc(name) + "?t=" + Date.now();
      }

      function refreshStills() {
        var host = document.getElementById("fg-cameras");
        if (!host) { stopStills(); return; }  // the page moved on (Turbo Drive)
        var imgs = host.querySelectorAll(".fg-cam-img");
        for (var i = 0; i < imgs.length; i++) refreshStill(imgs[i]);
      }

      // Only while the page is visible: a hidden tab asks Frigate for nothing.
      function startStills(refreshNow) {
        if (document.hidden) return;
        if (refreshNow) refreshStills();
        if (!stillTimer) stillTimer = setInterval(refreshStills, STILL_REFRESH_MS);
      }

      function stopStills() {
        if (!stillTimer) return;
        clearInterval(stillTimer);
        stillTimer = null;
      }

      function onVisibilityChange() {
        if (document.hidden) stopStills(); else startStills(true);
      }

      // Turbo is caching this page or navigating away: stop asking Frigate for stills.
      function onPageLeave() { stopStills(); }

      function renderCameras(cams) {
        var host = document.getElementById("fg-cameras");
        if (!host) return;
        clearKids(host);
        if (!cams || cams.length === 0) {
          host.appendChild(div("fg-empty", "No cameras configured. Edit config.yml to add RTSP sources."));
          return;
        }
        cams.forEach(function (c) {
          var card = div("fg-camera");
          card.appendChild(cameraStill(c.name));
          card.appendChild(div("fg-camera-name", c.name));
          var meta = div("fg-camera-meta");
          meta.appendChild(span(c.detect_enabled ? "fg-badge on" : "fg-badge off", c.detect_enabled ? "detect" : "detect off"));
          var res = (c.width && c.height) ? (c.width + "×" + c.height) : "?";
          meta.appendChild(document.createTextNode(" " + res));
          card.appendChild(meta);
          var objs = (c.tracked_objects || []).join(", ") || "none";
          card.appendChild(div("fg-camera-meta", "tracking: " + objs));
          host.appendChild(card);
        });
      }

      function renderEvents(events) {
        var host = document.getElementById("fg-events");
        if (!host) return;
        clearKids(host);
        if (!events || events.length === 0) {
          host.appendChild(div("fg-empty", "No events yet. Once a camera detects motion, events will appear here."));
          return;
        }
        events.forEach(function (e) {
          var card = div("fg-event");
          if (e.has_snapshot || e.has_clip) {
            var img = document.createElement("img");
            img.className = "fg-event-thumb";
            img.loading = "lazy";
            img.alt = (e.label || "event") + " on " + (e.camera || "");
            // Proxied through the gateway so Frigate JWT stays server-side
            img.src = "/api/frigate/events/" + encodeURIComponent(e.id) + "/thumbnail.jpg";
            img.onerror = function () { this.style.display = "none"; };
            card.appendChild(img);
          }
          var body = div("fg-event-body");
          var hdr = div("fg-event-camera", e.camera || "");
          body.appendChild(hdr);
          var labelRow = div("fg-event-label");
          labelRow.appendChild(span(labelCls(e.label), e.label || "unknown"));
          if (e.sub_label) {
            labelRow.appendChild(document.createTextNode(" " + e.sub_label));
          }
          if (typeof e.score === "number") {
            labelRow.appendChild(document.createTextNode(" " + Math.round(e.score * 100) + "%"));
          }
          body.appendChild(labelRow);
          body.appendChild(div("fg-event-time", relTime(e.start_time)));
          card.appendChild(body);
          host.appendChild(card);
        });
      }

      function showError(hostId, msg) {
        var host = document.getElementById(hostId);
        if (!host) return;
        clearKids(host);
        host.appendChild(div("fg-error", "Error: " + msg));
      }

      function loadCameras() {
        fetch("/api/frigate/cameras").then(function (r) { return r.json(); }).then(function (data) {
          if (data.error) return showError("fg-cameras", data.error);
          renderCameras(data.cameras);
        }).catch(function (err) { showError("fg-cameras", err.message); });
      }

      function loadEvents() {
        fetch("/api/frigate/events?limit=20").then(function (r) { return r.json(); }).then(function (data) {
          if (data.error) return showError("fg-events", data.error);
          renderEvents(data.events);
        }).catch(function (err) { showError("fg-events", err.message); });
      }

      function loadStats() {
        fetch("/api/frigate/stats").then(function (r) { return r.json(); }).then(function (data) {
          var target = document.getElementById("fg-stats");
          if (!target) return;
          if (data.error) { target.textContent = "Error: " + data.error; return; }
          var summary = {
            uptime_seconds: data.service && data.service.uptime,
            version: data.service && data.service.version,
            detectors: data.detectors ? Object.keys(data.detectors).map(function (k) {
              return { name: k, inference_ms: data.detectors[k].inference_speed };
            }) : [],
            processes: data.cpu_usages ? Object.keys(data.cpu_usages).length : 0,
          };
          target.textContent = JSON.stringify(summary, null, 2);
        }).catch(function (err) {
          var target = document.getElementById("fg-stats");
          if (target) target.textContent = "Fetch failed: " + err.message;
        });
      }

      if (!document.getElementById("fg-cameras")) return;

      document.addEventListener("visibilitychange", onVisibilityChange);
      document.addEventListener("turbo:before-cache", onPageLeave);
      document.addEventListener("turbo:before-visit", onPageLeave);
      startStills(false);
      loadCameras();
      loadEvents();
      loadStats();
    })();
  `;
}
